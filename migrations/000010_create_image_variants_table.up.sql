BEGIN;

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
