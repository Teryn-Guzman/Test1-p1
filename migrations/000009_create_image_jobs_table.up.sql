BEGIN;

CREATE TABLE IF NOT EXISTS image_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    public_id uuid NOT NULL DEFAULT uuidv4() UNIQUE,
    image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    error_message text,
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    failed_at timestamptz
);

COMMIT;
