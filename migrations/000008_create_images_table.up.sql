BEGIN;

CREATE TABLE IF NOT EXISTS images (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    original_filename text NOT NULL,
    stored_filename text NOT NULL UNIQUE,
    media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
