package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/teryn-guzman/gatekeeper-asynchronous/internal/data"
)

// Version 1 enforces a strict upload boundary: the browser may preview the file,
// but the server is the authority for validation, storage, and durable job creation.
const (
	maxImageSize   int64 = 10 * 1024 * 1024
	maxRequestSize int64 = maxImageSize + 1024*1024
)

var (
	errInvalidImageUpload = errors.New("image upload is too large or malformed")
	errMissingImageField  = errors.New("image field is required")
	errEmptyImage         = errors.New("image file is empty")
	errImageTooLarge      = errors.New("image must be no larger than 10 MB")
	errUnsupportedImage   = errors.New("only JPEG and PNG images are supported")
	errUndecodableImage   = errors.New("uploaded file is not a decodable JPEG or PNG")
)

type uploadedImage struct {
	data             []byte
	originalFilename string
	contentType      string
	storedFilename   string
}

func randomFilename(ext string) (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x%s", bytes, ext), nil
}

// createImageHandler accepts one multipart upload, stores the original to disk,
// creates the corresponding image + queued job records, and returns a 202 Accepted.
func (app *application) createImageHandler(w http.ResponseWriter, r *http.Request) {
	// Limit the complete multipart request as well as the image field. This protects
	// the handler when a client sends an inaccurate or missing multipart file size.
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)

	uploaded, err := app.parseUploadedImage(r)
	if err != nil {
		var clientErr error
		switch {
		case errors.Is(err, errInvalidImageUpload),
			errors.Is(err, errMissingImageField),
			errors.Is(err, errEmptyImage),
			errors.Is(err, errImageTooLarge),
			errors.Is(err, errUnsupportedImage),
			errors.Is(err, errUndecodableImage):
			clientErr = err
		default:
			app.serverErrorResponse(w, r, err)
			return
		}
		app.badRequestResponse(w, r, clientErr)
		return
	}

	if err := app.storeOriginalImage(uploaded); err != nil {
		app.serverErrorResponse(w, r, err)
		return
	}

	imageRecord := &data.Image{
		OriginalFilename: filepath.Base(uploaded.originalFilename),
		StoredFilename:   uploaded.storedFilename,
		MediaType:        uploaded.contentType,
		Size:             int64(len(uploaded.data)),
	}
	job := &data.ImageJob{}

	ctx, cancel := context.WithTimeout(r.Context(), 5e9)
	defer cancel()

	if err := app.models.Images.Insert(ctx, imageRecord, job); err != nil {
		_ = os.Remove(filepath.Join(app.config.storageDir, uploaded.storedFilename))
		app.serverErrorResponse(w, r, err)
		return
	}

	statusURL := "/v1/jobs/" + job.ID
	headers := make(http.Header)
	headers.Set("Location", statusURL)
	app.writeJSON(w, http.StatusAccepted, envelope{
		"image_id":   imageRecord.ID,
		"job_id":     job.ID,
		"status":     job.Status,
		"status_url": statusURL,
	}, headers)
}

// parseUploadedImage validates the multipart payload before any durable work is created.
func (app *application) parseUploadedImage(r *http.Request) (uploadedImage, error) {
	if err := r.ParseMultipartForm(maxRequestSize); err != nil {
		return uploadedImage{}, errInvalidImageUpload
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		return uploadedImage{}, errMissingImageField
	}
	defer file.Close()

	if header.Size <= 0 {
		return uploadedImage{}, errEmptyImage
	}
	if header.Size > maxImageSize {
		return uploadedImage{}, errImageTooLarge
	}

	dataBytes, err := io.ReadAll(io.LimitReader(file, maxImageSize+1))
	if err != nil {
		return uploadedImage{}, err
	}
	if len(dataBytes) == 0 {
		return uploadedImage{}, errEmptyImage
	}
	if int64(len(dataBytes)) > maxImageSize {
		return uploadedImage{}, errImageTooLarge
	}

	contentType := http.DetectContentType(dataBytes)
	if contentType != "image/jpeg" && contentType != "image/png" {
		return uploadedImage{}, errUnsupportedImage
	}

	decoded, format, err := image.Decode(bytes.NewReader(dataBytes))
	if err != nil || (format != "jpeg" && format != "png") {
		return uploadedImage{}, errUndecodableImage
	}
	_ = decoded

	ext := ".png"
	if contentType == "image/jpeg" {
		ext = ".jpg"
	}

	storedFilename, err := randomFilename(ext)
	if err != nil {
		return uploadedImage{}, err
	}

	return uploadedImage{
		data:             dataBytes,
		originalFilename: header.Filename,
		contentType:      contentType,
		storedFilename:   storedFilename,
	}, nil
}

// storeOriginalImage keeps the original file under a server-controlled filename.
func (app *application) storeOriginalImage(uploaded uploadedImage) error {
	path := filepath.Join(app.config.storageDir, uploaded.storedFilename)
	if err := os.WriteFile(path, uploaded.data, 0600); err != nil {
		return err
	}
	return nil
}

func (app *application) getVariantHandler(w http.ResponseWriter, r *http.Request) {
	variant, err := app.models.Images.Variant(r.Context(), r.PathValue("id"), r.PathValue("name"))
	if errors.Is(err, data.ErrRecordNotFound) {
		app.notFoundResponse(w, r)
		return
	}
	if err != nil {
		app.serverErrorResponse(w, r, err)
		return
	}
	http.ServeFile(w, r, filepath.Join(app.config.storageDir, variant.Filename))
}

// processNextImageJob is the worker-side execution path. It claims a queued image job,
// reads the original, generates the required variants, and marks the job complete.
func (app *application) processNextImageJob(ctx context.Context) error {
	job, err := app.models.Images.ClaimNext(ctx)
	if err != nil {
		return err
	}

	imageRecord, err := app.models.Images.Original(ctx, job.ImageID)
	if err != nil {
		_ = app.models.Images.Fail(ctx, job.ID, "original image is unavailable")
		return err
	}

	source, err := os.Open(filepath.Join(app.config.storageDir, imageRecord.StoredFilename))
	if err != nil {
		_ = app.models.Images.Fail(ctx, job.ID, "original image is unavailable")
		return err
	}
	defer source.Close()

	decoded, _, err := image.Decode(source)
	if err != nil {
		_ = app.models.Images.Fail(ctx, job.ID, "original image could not be decoded")
		return err
	}

	// The all-or-nothing contract requires all three variants before the job is complete.
	for _, profile := range []struct {
		name          string
		width, height int
		crop          bool
	}{
		{"thumbnail", 150, 150, true},
		{"preview", 800, 600, false},
		{"display", 1200, 900, false},
	} {
		output, width, height := resize(decoded, profile.width, profile.height, profile.crop)
		filename, err := randomFilename(".png")
		if err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not create output")
			return err
		}

		path := filepath.Join(app.config.storageDir, filename)
		f, err := os.Create(path)
		if err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not store output")
			return err
		}

		if err = png.Encode(f, output); err != nil {
			_ = f.Close()
			_ = app.models.Images.Fail(ctx, job.ID, "could not encode output")
			return err
		}
		if err := f.Close(); err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not close output file")
			return err
		}

		info, err := os.Stat(path)
		if err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not read output metadata")
			return err
		}

		if err := app.models.Images.AddVariant(ctx, job.ImageID, profile.name, filename, width, height, info.Size()); err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not record output")
			return err
		}
	}

	return app.models.Images.Complete(ctx, job.ID)
}

// resize handles the required variant sizing rules while preserving aspect ratio
// unless the variant explicitly requires a crop, such as the thumbnail output.
func resize(source image.Image, maxWidth, maxHeight int, crop bool) (image.Image, int, int) {
	bounds := source.Bounds()
	sw, sh := bounds.Dx(), bounds.Dy()
	scale := float64(maxWidth) / float64(sw)
	if value := float64(maxHeight) / float64(sh); (crop && value > scale) || (!crop && value < scale) {
		scale = value
	}
	width, height := int(float64(sw)*scale), int(float64(sh)*scale)
	if crop {
		width, height = maxWidth, maxHeight
	}

	output := image.NewRGBA(image.Rect(0, 0, width, height))
	scaledWidth, scaledHeight := int(float64(sw)*scale), int(float64(sh)*scale)
	offsetX, offsetY := 0, 0
	if crop {
		offsetX, offsetY = (scaledWidth-width)/2, (scaledHeight-height)/2
	}

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			sourceX := int(float64(x+offsetX) / scale)
			sourceY := int(float64(y+offsetY) / scale)
			output.Set(x, y, source.At(bounds.Min.X+sourceX, bounds.Min.Y+sourceY))
		}
	}
	return output, width, height
}
