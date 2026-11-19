# RIDGE 2.7 — CI verification record

Date: 2026-11-19

## Local checks performed against the 2.6 starter source archive

| Check | Result |
|---|---|
| Go unit tests | PASS |
| Go race detector | PASS |
| `go vet ./...` | PASS |
| `go build ./...` | PASS |
| Migration filename sequence | PASS — 0001 through 0013 |
| Source/embedded SQL body comparison | PASS — all 13 bodies match after removing standalone transaction wrapper lines |

The migration comparison intentionally ignores only standalone `BEGIN;` and `COMMIT;` wrapper lines. The embedded migration runner owns transaction boundaries; standalone SQL files retain wrappers for manual application. All other SQL text must match.

## Checks not run

- Live PostgreSQL/PostGIS migration application: unavailable locally because neither Docker/Podman nor `psql` is installed.
- Unreal Engine 5.8 C++ compilation: unavailable because Unreal Editor/Build Tool is not installed.
- Multi-node network/failover test and 500-player load test: not run.

## Repository status

The checks above were run against the extracted local `RIDGE_Development_Starter_2.6.zip`, not against source files in this GitHub repository. The default branch initially contained only a placeholder README. The GitHub PR adds the repository foundation and CI gate definitions; the full backend/Unreal source import remains a separate required operation. CI jobs are guarded so they skip while the source tree is absent rather than reporting a misleading pass.
