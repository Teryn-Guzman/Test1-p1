# ImageLab

## Teryn Guzman & Kelvin Gordon

ImageLab is an asynchronous image-processing application. The browser uploads
one JPEG or PNG, the Go API durably records the original and a queued job, and
one in-process worker generates image variants independently of the upload
request.

The API returns `202 Accepted` when the original image and queued job have been
stored. The browser then short-polls the job resource approximately once per
second until the job is `completed` or `failed`.

## Requirements

- Go version declared in `go.mod`
- PostgreSQL
- `psql`
- The `migrate` CLI

The migrations use PostgreSQL extensions/functions supplied by the starter
project, including `citext`, `uuidv7()`, and `uuidv4()`.

## Setup

Create a local environment file and edit the connection details if needed:

```bash
cp .envrc.example .envrc
source .envrc
```

The default DSN is:

```text
postgres://gatekeeper:password@localhost:5432/gatekeeper?sslmode=disable
```

Create the database and required extensions as needed for your PostgreSQL
installation, then apply the migrations:

```bash
psql "$GATEKEEPER_DB_DSN" -c 'CREATE EXTENSION IF NOT EXISTS citext;'
make db/migrations/up
```

The migration command asks for confirmation. `.envrc` is ignored by Git and
should not be committed.

## Run the application

Start the API and keep this terminal open:

```bash
source .envrc
make run/api
```

Open the browser at:

```text
http://localhost:4000/
```

The API serves the frontend from `frontend/`, so do not open
`frontend/index.html` directly from the filesystem.

## Image workflow

1. Select a JPEG or PNG no larger than 10 MB.
2. The browser shows a local preview without sending a request.
3. Click **Process image** once.
4. `POST /v1/images` validates and stores the original image, creates a queued
   PostgreSQL job, and returns `202 Accepted`.
5. The browser polls `GET /v1/jobs/{job_id}` every second.
6. The worker claims the queued job, creates all three variants, records their
   metadata, and marks the job `completed`.
7. The browser stops polling and displays the generated images.

The allowed job states are:

```text
queued -> processing -> completed
                       or failed
```

Retrieval errors are treated as observation failures. The browser preserves the
last known job and offers **Try again** instead of falsely marking the job as
failed or uploading the image again.

## HTTP API

### Upload an image

```http
POST /v1/images
Content-Type: multipart/form-data
```

The multipart field is named `image`. A successful response is `202 Accepted`
with a `Location` header and a body like:

```json
{
  "image_id": "...",
  "job_id": "...",
  "status": "queued",
  "status_url": "/v1/jobs/..."
}
```

Example:

```bash
curl --include --form image=@/path/to/photo.jpg \
  http://localhost:4000/v1/images
```

### Check a job

```bash
curl http://localhost:4000/v1/jobs/JOB_ID
```

A completed job includes metadata for `thumbnail`, `preview`, and `display`.

### Retrieve a variant

```text
GET /v1/images/{image_id}/variants/{name}
```

Known variants are served from the local storage directory. Arbitrary file
paths are not exposed.

## Variants

| Variant | Contract |
| --- | --- |
| `thumbnail` | Exact 150 x 150 square crop |
| `preview` | Fits within 800 x 600 while preserving aspect ratio |
| `display` | Fits within 1200 x 900 while preserving aspect ratio |

The database stores image, job, and variant metadata. Original and generated
image files are stored under `storage/`, which is created when the API starts.

## Database inspection

```bash
make db/psql
```

Useful queries:

```sql
SELECT * FROM images ORDER BY created_at DESC;
SELECT * FROM image_jobs ORDER BY queued_at DESC;
SELECT * FROM image_variants ORDER BY created_at DESC;
```

## Validation and troubleshooting

Run the Go tests and frontend syntax check:

```bash
go test ./...
node --check frontend/app.js
```

Check that the API is running:

```bash
curl http://localhost:4000/v1/healthcheck
```

If the browser page is blank or appears stale, open `http://localhost:4000/`
and hard-refresh with `Ctrl+Shift+R`. Do not open the HTML file directly.

If an upload does not appear in the Network panel, the request was stopped in
the browser before it reached the API. Check that the selected file is a JPEG
or PNG under 10 MB and that **Process image** is enabled.

The application intentionally uses one worker, PostgreSQL, local filesystem
storage, ordinary HTTP polling, and vanilla JavaScript for Version 1.