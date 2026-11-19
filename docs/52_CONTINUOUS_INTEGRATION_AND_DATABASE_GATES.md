# RIDGE — Continuous Integration and Database Gates

## Why this gate exists

RIDGE's backend uses ordered PostgreSQL migrations and also embeds a copy of those migrations into the Go binary. A mismatch can make manual operations and production startup apply different schemas. CI checks ordered filenames and compares SQL bodies while accounting for the standalone `BEGIN;` / `COMMIT;` wrappers omitted from embedded migrations because the Go runner owns the transaction boundary. It then applies the standalone migration set to a clean PostGIS database.

## Workflow

`.github/workflows/backend-ci.yml` runs automatically when files under `backend/` change. It can also be started manually; set `run_checks=true` to run the jobs.

### Go job

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- `go build ./...`

### PostGIS job

- Starts a clean PostgreSQL 16 / PostGIS 3.4 service.
- Checks that numbered migration filenames are contiguous from 0001.
- Compares SQL bodies in the source and embedded directories, excluding only exact outer transaction-wrapper lines.
- Applies every standalone migration in numeric order with `ON_ERROR_STOP=1`.
- Confirms PostGIS and core persistence tables exist.

The workflow is scoped to backend source changes. Manual runs default to skipping checks until explicitly enabled, avoiding a false green for a documentation-only repository state.

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
