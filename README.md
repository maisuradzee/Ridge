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


## Increment 2.8 — virtual tax calculation

The starter archive adds a deterministic Go tax-calculation library using integer tetri, configurable progressive brackets and versioned policies. Tax rates are intentionally not hard-coded. The library is calculation groundwork only; tax persistence, wallet/company settlement and production tax rules are not yet implemented. See `docs/54_INCREMENT_2.8_VIRTUAL_TAX_CALCULATION.md`.


## Increment 2.9 — offline player protection

The backend includes a fail-closed domain guard that requires authoritative active session presence and a non-expired lease before a player can be targeted by hostile player actions. It is a domain primitive and must still be wired into every combat, robbery, kidnapping, and asset-related command path. See `docs/55_INCREMENT_2.9_OFFLINE_PLAYER_PROTECTION.md`.
