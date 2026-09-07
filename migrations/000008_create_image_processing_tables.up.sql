BEGIN;

CREATE TABLE IF NOT EXISTS images (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    original_filename text NOT NULL,
    stored_filename text NOT NULL UNIQUE,
    media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS image_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    error_message text,
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    failed_at timestamptz
);

CREATE TABLE IF NOT EXISTS image_variants (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name IN ('thumbnail', 'preview', 'display')),
    stored_filename text NOT NULL UNIQUE,
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (image_id, name)
);

COMMIT;