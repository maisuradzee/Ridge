# RIDGE — Continuous Integration and Database Gates

## Why this gate exists

RIDGE's backend uses ordered PostgreSQL migrations and also embeds a copy of those migrations into the Go binary. A mismatch between the two copies can make local operations and production startup apply different schemas. CI now checks the two copies byte-for-byte and applies the ordered migration set to a clean PostGIS database.

## Workflow

`.github/workflows/backend-ci.yml` runs when backend, migration scripts or the workflow itself change, and can also be started manually.

### Go job

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- `go build ./...`

### PostGIS job

- Starts a clean PostgreSQL 16 / PostGIS 3.4 service.
- Checks that numbered migration filenames are contiguous from 0001.
- Checks that source and embedded SQL files are identical.
- Applies every migration in numeric order with `ON_ERROR_STOP=1`.
- Confirms PostGIS and core persistence tables exist.

The jobs are skipped until the backend source tree is committed. This avoids reporting a false green for a documentation-only repository state.

## Local execution

From the repository root:

```bash
bash scripts/verify-migration-mirror.sh
cd backend
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

To run the database migration integration locally, start the PostGIS service from `infra/compose.yaml`, then apply `backend/migrations/*.sql` in lexical order using `psql` with `ON_ERROR_STOP=1`.

## Verification boundary

A green migration job verifies clean-database SQL compatibility for the checked migration set. It does not prove application query correctness under concurrency, backup/restore safety, production TLS, multi-node recovery, Unreal integration, GIS data quality, or the 500-player target. Those require dedicated integration, operational and load tests.
