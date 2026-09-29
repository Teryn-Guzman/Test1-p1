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

For a visible polling demonstration, use a worker-only delay. Upload acceptance
still returns immediately; the job remains in `processing` during the delay:

```bash
make run/api image_processing_delay=10s
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
failed or uploading the image again. If the initial `POST /v1/images` itself
fails (for example, a lost connection before any job exists), the UI instead
offers **Retry upload**, which resubmits the same selected file.

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

The database stores image, job, and variant metadata. Originals are stored in
`storage/`; generated files are stored in `storage/variants/`. Both directories
are created when the API starts.

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

## Week 3/4 acceptance demonstration

Run these steps in order. Steps 3 onward use a second terminal, with the
server from step 3 left running throughout.

### 1. Automated tests

```bash
go test ./... -v
```

### 2. Sample files

`tmp/` should not be committed.

```bash
mkdir -p tmp
echo "tmp/" >> .gitignore
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > tmp/tiny.png
printf 'not a valid PNG' > tmp/corrupt.png
echo hello > tmp/note.txt
```

### 3. Start the server

```bash
make run/api image_processing_delay=10s
```

The delay makes the async behavior in the steps below observable.

### 4. Required outcomes and failures

- Reject an empty or unsupported file and confirm no job is queued:

  ```bash
  curl -s -o /dev/null -w "text file: %{http_code}\n" \
    -F "image=@tmp/note.txt;type=text/plain" http://localhost:4000/v1/images
  curl -s -o /dev/null -w "no file:   %{http_code}\n" \
    -X POST http://localhost:4000/v1/images
  ```

- Submit a corrupt `.png` payload with a PNG multipart content type. POST should
  return `202`; the worker should later produce `status = failed`, a safe
  `error_message`, and `failed_at`.

  ```bash
  JOB=$(curl -s -F "image=@tmp/corrupt.png;type=image/png" \
    http://localhost:4000/v1/images | grep -o '"job_id": *"[^"]*"' | cut -d'"' -f4)
  sleep 12; curl -s http://localhost:4000/v1/jobs/$JOB
  ```

- Upload a valid image and confirm the original is in `storage/` and the three
  output files are in `storage/variants/`:

  ```bash
  curl -i -w "\nack: %{time_total}s\n" \
    -F "image=@tmp/tiny.png;type=image/png" http://localhost:4000/v1/images
  ls storage storage/variants
  ```

- After a terminal state, use **Choose another image** and submit a second image.

### 5. Five-image burst (queue position with one worker)

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "ack $i: %{http_code} %{time_total}s\n" \
    -F "image=@tmp/tiny.png;type=image/png" http://localhost:4000/v1/images
done

# Wait until all five have reached a terminal state before reading the table.
while [ "$(psql "$GATEKEEPER_DB_DSN" -tAc \
  "SELECT COUNT(*) FROM image_jobs WHERE status IN ('queued','processing') \
   AND queued_at > now() - interval '2 minutes';")" != "0" ]; do
  sleep 2
done

psql "$GATEKEEPER_DB_DSN" -c "SELECT public_id, status, \
  started_at - queued_at AS queue_wait, \
  COALESCE(completed_at, failed_at) - started_at AS processing, \
  COALESCE(completed_at, failed_at) - queued_at AS total \
  FROM image_jobs ORDER BY queued_at DESC LIMIT 5;"
```

`queue_wait` should climb by roughly one delay interval (~10s) per job, since
one worker processes them strictly in order. For the single-image measurement
row, run one upload by itself and read the same query with `LIMIT 1`. To see
live `queue_position` values, poll a queued job's `status_url` during the
burst instead of waiting for it to finish.

### 6. Polling and retry (browser)

1. Open `http://localhost:4000`. In DevTools **Network**, enable **Preserve
   log** and filter for `/v1/jobs/`.
2. Upload and process an image. Confirm the POST returns `202` before the
   delay ends, then observe separate status GET requests about one second
   apart.
3. Confirm the card moves through `queued`/`processing` to `completed`,
   polling stops, and all three variants appear.
4. To simulate an observation error, switch Network throttling to **Offline**
   after the job is accepted. The UI should show **Unable to check status**,
   keep the last known job state, and offer **Try again**. Go back online and
   retry; it must observe the same job URL without a new POST.
5. To simulate a submission failure, stop the server (or go Offline) before
   clicking **Process image**. The UI should show **Upload failed** with a
   **Retry upload** button. Restart the server (or go back online) and click
   it; it must resubmit the same selected file without reselecting it.

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