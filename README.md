# RIDGE

RIDGE is a persistent, realistic, multiplayer life simulation set in Georgia. This repository is the source of truth for implementation work.

## Product baseline

- Engine target: Unreal Engine 5.8; PC-first, with mobile adaptation later.
- Initial world: geographically grounded Tbilisi, beginning in Saburtalo.
- Shared-world target: 500 concurrent players, using distributed simulation nodes and persistent server-authoritative state.
- Economy: entirely virtual; no real-money cash-out and no pay-to-win.
- Offline safety: players and personal assets are protected from hostile player actions while offline.
- Server authority: clients never authoritatively set balances, inventory ownership, player positions, or persistent world state.
- Persistence: durable player snapshots, idempotent events, session ownership, controlled handoff and crash recovery.
- Game design decisions are governed by the consolidated RIDGE Master GDD 1.3.

## Repository layout

- `backend/` — Go HTTP API, persistence contracts, migrations and node agent.
- `unreal/` — Unreal Engine project and dedicated-server integration.
- `infra/` — local infrastructure and service examples.
- `docs/` — architecture, API contracts, operational procedures and implementation notes.
- `tests/` — acceptance scenarios.

## Local backend checks

```sh
cd backend
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

A successful local Go test does not imply that PostgreSQL/PostGIS has been provisioned, migrations applied, Unreal compiled, or a multi-node production world deployed. Those require separate integration and operational verification.

## Security and operations

- Keep production secrets out of source control.
- Use separate credentials for API/node authentication and the local Unreal recovery bridge.
- Use TLS on all non-loopback production service links.
- Expose health and readiness separately; readiness must reflect dependencies actually required to serve traffic.
- Run schema migrations through a controlled deployment step and a dedicated migration role.
- Preserve auditability and idempotency for state-changing operations.

## Status

This repository is the project foundation. The 2.x starter archives document implemented backend increments and their verification boundaries. Consult the increment test reports before treating a feature as production-ready.
