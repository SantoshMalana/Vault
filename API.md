# Object and administration API

Direct gateway API: `http://127.0.0.1:7400`. Send `Authorization: Bearer <access-token>`. The dashboard uses the same API through `/api/v1` and an HTTP-only session cookie.

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Metadata readiness, no credentials required |
| `GET /v1/cluster` | Live inventory, policies, recovery and metrics |
| `GET /v1/buckets` | Authorized bucket policies |
| `PUT /v1/buckets` | Admin: create/update `{name,n,w,r,sloppy}` |
| `GET /v1/objects/:bucket?limit=50&cursor=…` | Paginated current objects; use returned cursor verbatim |
| `PUT /v1/objects/:bucket/:key` | Stream an object, optionally with client SHA-256 |
| `GET /v1/objects/:bucket/:key` | Verified download; optional `consistency=one|quorum|all` |
| `HEAD /v1/objects/:bucket/:key` | Committed metadata plus replica availability check |
| `DELETE /v1/objects/:bucket/:key` | Commit a deletion marker |
| `POST /v1/uploads` | Create `{bucket,key,contentType}` multipart session |
| `GET /v1/uploads/:id` | Resume state and committed part checksums |
| `PUT /v1/uploads/:id/parts/:number` | Store a part; Content-Length required, at most 16 MiB |
| `POST /v1/uploads/:id/complete` | Publish ordered `{parts:[{number,sha256},…]}` |
| `DELETE /v1/uploads/:id` | Abort an uncommitted session |
| `POST /v1/nodes` | Admin: register `{id,url,domain}` after authenticated health verification |
| `POST /v1/nodes/:id/drain` | Admin: migrate current replicas before removing membership |
| `POST /v1/repair` | Admin: schedule integrity/recovery work |
| `GET /v1/metrics` | Admin: Prometheus text counters |

PUT accepts `Idempotency-Key`, `If-Match`, `If-None-Match: *`, and `x-content-sha256`. GET accepts a single HTTP byte range. ETag is the **version identifier**, not the content hash. The hash is returned separately in `x-content-sha256`. Object keys are URL encoded and can include directory-like slashes.

```sh
curl -H "Authorization: Bearer $VAULT_TOKEN" \
  -H "Idempotency-Key: report-upload-001" \
  -H "Content-Type: application/pdf" \
  --upload-file report.pdf \
  http://127.0.0.1:7400/v1/objects/default/reports/report.pdf

curl -H "Authorization: Bearer $VAULT_TOKEN" \
  http://127.0.0.1:7400/v1/objects/default/reports/report.pdf \
  --output downloaded.pdf
```

Multipart sessions expire after 24 hours. Persist the upload ID and per-part checksums. Re-upload only missing parts, then provide contiguous part numbers starting at 1. Parts are invisible in ordinary object listings. Completion is retriable and publishes the final object only after its durable write quorum and metadata transaction succeed. Cancelling or expiring a session does not physically erase its staged replica files in this version.

Errors are JSON `{error: string}`: 400 invalid request, 401 missing/invalid credential, 403 role or bucket denied, 404 absent object, 409 concurrent update or incompatible retry, 412 failed conditional update, 413 size limit, 416 invalid range, 422 checksum mismatch, 503 quorum/unavailability/overload, 507 insufficient disk space. Connection interruptions during a streaming request can terminate the connection before a JSON error is delivered; use idempotency to resolve the outcome.
