package main

import (
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
	"strings"

	"github.com/teryn-guzman/gatekeeper-asynchronous/internal/data"
)

const maxImageSize int64 = 10 * 1024 * 1024

func randomFilename(ext string) (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x%s", bytes, ext), nil
}

func (app *application) createImageHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImageSize+1024*1024)
	if err := r.ParseMultipartForm(maxImageSize + 1024*1024); err != nil {
		app.badRequestResponse(w, r, errors.New("image upload is too large or malformed"))
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		app.badRequestResponse(w, r, errors.New("image field is required"))
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > maxImageSize {
		app.badRequestResponse(w, r, errors.New("image must be no larger than 10 MB"))
		return
	}
	dataBytes, err := io.ReadAll(io.LimitReader(file, maxImageSize+1))
	if err != nil {
		app.serverErrorResponse(w, r, err)
		return
	}
	kind := http.DetectContentType(dataBytes)
	if kind != "image/jpeg" && kind != "image/png" {
		app.badRequestResponse(w, r, errors.New("only JPEG and PNG images are supported"))
		return
	}
	decoded, format, err := image.Decode(strings.NewReader(string(dataBytes)))
	if err != nil || (format != "jpeg" && format != "png") {
		app.badRequestResponse(w, r, errors.New("uploaded file is not a decodable JPEG or PNG"))
		return
	}
	ext := ".png"
	if kind == "image/jpeg" {
		ext = ".jpg"
	}
	stored, err := randomFilename(ext)
	if err != nil {
		app.serverErrorResponse(w, r, err)
		return
	}
	if err := os.WriteFile(filepath.Join(app.config.storageDir, stored), dataBytes, 0600); err != nil {
		app.serverErrorResponse(w, r, err)
		return
	}
	imageRecord := &data.Image{OriginalFilename: filepath.Base(header.Filename), StoredFilename: stored, MediaType: kind, Size: int64(len(dataBytes))}
	job := &data.ImageJob{}
	ctx, cancel := context.WithTimeout(r.Context(), 5e9)
	defer cancel()
	if err := app.models.Images.Insert(ctx, imageRecord, job); err != nil {
		_ = os.Remove(filepath.Join(app.config.storageDir, stored))
		app.serverErrorResponse(w, r, err)
		return
	}
	statusURL := "/v1/jobs/" + job.ID
	headers := make(http.Header)
	headers.Set("Location", statusURL)
	_ = decoded
	app.writeJSON(w, http.StatusAccepted, envelope{"image_id": imageRecord.ID, "job_id": job.ID, "status": job.Status, "status_url": statusURL}, headers)
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
	profiles := []struct {
		name          string
		width, height int
		crop          bool
	}{{"thumbnail", 150, 150, true}, {"preview", 800, 600, false}, {"display", 1200, 900, false}}
	for _, profile := range profiles {
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
		err = png.Encode(f, output)
		f.Close()
		if err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not encode output")
			return err
		}
		info, _ := os.Stat(path)
		if err := app.models.Images.AddVariant(ctx, job.ImageID, profile.name, filename, width, height, info.Size()); err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not record output")
			return err
		}
	}
	return app.models.Images.Complete(ctx, job.ID)
}

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
