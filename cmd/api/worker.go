package main

import (
	"context"
	"database/sql"
	"errors"
	"image"
	_ "image/jpeg"
	"image/png"
	_ "image/png"
	"os"
	"path/filepath"
	"time"
)

// processNextImageJob claims one queued job, processes it, and records either
// a completed result or a durable failure for the polling endpoint.
func (app *application) processNextImageJob(ctx context.Context) error {
	job, err := app.models.Images.ClaimNext(ctx)
	if err != nil {
		return err
	}
	if app.config.imageProcessingDelay > 0 {
		// Keep the delay in the worker so POST /v1/images still returns 202
		// immediately while GET /v1/jobs/{public_id} shows processing.
		timer := time.NewTimer(app.config.imageProcessingDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
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

		path := filepath.Join(app.variantStorageDir(), filename)
		file, err := os.Create(path)
		if err != nil {
			_ = app.models.Images.Fail(ctx, job.ID, "could not store output")
			return err
		}
		if err = png.Encode(file, output); err != nil {
			_ = file.Close()
			_ = app.models.Images.Fail(ctx, job.ID, "could not encode output")
			return err
		}
		if err := file.Close(); err != nil {
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

// resize preserves aspect ratio, except for the fixed-size cropped thumbnail.
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

// startImageWorker runs one background worker that periodically polls the database for
// queued image jobs and processes them without blocking the HTTP request path.
func (app *application) startImageWorker(ctx context.Context) {
	app.wg.Add(1)
	go func() {
		defer app.wg.Done()
		ticker := time.NewTicker(app.config.workerPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := app.processNextImageJob(ctx); err != nil && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) {
					app.logger.Error("image worker failed", "error", err)
				}
			}
		}
	}()
}
