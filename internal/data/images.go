package data

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Image stores the uploaded original file and its metadata.
type Image struct {
	ID, OriginalFilename, StoredFilename, MediaType string
	Size                                            int64
}

// ImageJob tracks the lifecycle of an accepted upload from queued to completed/failed.
type ImageJob struct {
	ID          string     `json:"id"`
	ImageID     string     `json:"image_id"`
	Status      string     `json:"status"`
	Error       *string    `json:"error,omitempty"`
	QueuedAt    time.Time  `json:"queued_at"`
	StartedAt   *time.Time `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at"`
	FailedAt    *time.Time `json:"failed_at,omitempty"`
	Variants    []Variant  `json:"variants,omitempty"`
}

// Variant stores the generated output metadata returned to the browser.
type Variant struct {
	Name     string `json:"name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	URL      string `json:"url"`
	Filename string `json:"-"`
	Size     int64  `json:"-"`
}

type ImageModel struct{ DB *sql.DB }

// Insert persists the original upload and creates the initial queued job.
func (m ImageModel) Insert(ctx context.Context, image *Image, job *ImageJob) error {
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `INSERT INTO images (original_filename, stored_filename, media_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`, image.OriginalFilename, image.StoredFilename, image.MediaType, image.Size).Scan(&image.ID); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `INSERT INTO image_jobs (image_id) VALUES ($1) RETURNING id, status, queued_at`, image.ID).Scan(&job.ID, &job.Status, &job.QueuedAt); err != nil {
		return err
	}
	job.ImageID = image.ID
	return tx.Commit()
}

// ClaimNext atomically claims the next queued job for processing.
func (m ImageModel) ClaimNext(ctx context.Context) (*ImageJob, error) {
	tx, err := m.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	job := &ImageJob{}
	if err := tx.QueryRowContext(ctx, `SELECT id, image_id FROM image_jobs WHERE status='queued' ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&job.ID, &job.ImageID); err != nil {
		return nil, err
	}
	if err := tx.QueryRowContext(ctx, `UPDATE image_jobs SET status='processing', started_at=now() WHERE id=$1 RETURNING started_at`, job.ID).Scan(&job.StartedAt); err != nil {
		return nil, err
	}
	job.Status = "processing"
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return job, nil
}

// GetJob returns the current job state together with any generated variant metadata.
func (m ImageModel) GetJob(ctx context.Context, id string) (*ImageJob, error) {
	job := &ImageJob{}
	err := m.DB.QueryRowContext(ctx, `SELECT id,image_id,status,error_message,queued_at,started_at,completed_at,failed_at FROM image_jobs WHERE id=$1`, id).Scan(&job.ID, &job.ImageID, &job.Status, &job.Error, &job.QueuedAt, &job.StartedAt, &job.CompletedAt, &job.FailedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRecordNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := m.DB.QueryContext(ctx, `SELECT name,width,height,stored_filename,size_bytes FROM image_variants WHERE image_id=$1 ORDER BY CASE name WHEN 'thumbnail' THEN 1 WHEN 'preview' THEN 2 ELSE 3 END`, job.ImageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v Variant
		if err := rows.Scan(&v.Name, &v.Width, &v.Height, &v.Filename, &v.Size); err != nil {
			return nil, err
		}
		v.URL = "/v1/images/" + job.ImageID + "/variants/" + v.Name
		job.Variants = append(job.Variants, v)
	}
	return job, rows.Err()
}

// Original fetches the uploaded image record by its database ID.
func (m ImageModel) Original(ctx context.Context, imageID string) (Image, error) {
	var image Image
	err := m.DB.QueryRowContext(ctx, `SELECT id,original_filename,stored_filename,media_type,size_bytes FROM images WHERE id=$1`, imageID).Scan(&image.ID, &image.OriginalFilename, &image.StoredFilename, &image.MediaType, &image.Size)
	if errors.Is(err, sql.ErrNoRows) {
		return image, ErrRecordNotFound
	}
	return image, err
}
// AddVariant saves one generated output file and its dimension metadata.
func (m ImageModel) AddVariant(ctx context.Context, imageID, name, filename string, width, height int, size int64) error {
	_, err := m.DB.ExecContext(ctx, `INSERT INTO image_variants (image_id,name,stored_filename,width,height,size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`, imageID, name, filename, width, height, size)
	return err
}
// Complete marks the job as finished once all variants have been created.
func (m ImageModel) Complete(ctx context.Context, id string) error {
	_, err := m.DB.ExecContext(ctx, `UPDATE image_jobs SET status='completed',completed_at=now() WHERE id=$1`, id)
	return err
}
// Fail records a safe error message when image processing cannot complete.
func (m ImageModel) Fail(ctx context.Context, id, message string) error {
	_, err := m.DB.ExecContext(ctx, `UPDATE image_jobs SET status='failed',error_message=$2,failed_at=now() WHERE id=$1`, id, message)
	return err
}
// Variant looks up a single generated output by image ID and variant name.
func (m ImageModel) Variant(ctx context.Context, imageID, name string) (Variant, error) {
	var v Variant
	err := m.DB.QueryRowContext(ctx, `SELECT name,width,height,stored_filename,size_bytes FROM image_variants WHERE image_id=$1 AND name=$2`, imageID, name).Scan(&v.Name, &v.Width, &v.Height, &v.Filename, &v.Size)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrRecordNotFound
	}
	return v, err
}
