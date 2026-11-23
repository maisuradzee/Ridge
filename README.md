# RIDGE — Saburtalo Vertical Slice

RIDGE is an Unreal Engine 5.8 real-life open-world simulator prototype, with the first playable area planned around Saburtalo, Tbilisi.

## Current engineering snapshot — BotLab V14

Release status: **VERIFIED_WITH_LIMITATIONS**.

V14 adds 23 new or modified project files, including:

- 303 player/NPC action intents across 28 action families.
- 16 synthetic, non-clinical decision archetypes and 20 environmental axes.
- 16,000 simulated decisions (64 agents × 250 actions).
- 18 isolated stateful interaction-contract bindings covering access, ownership, inventory, wallet transfers, mission rewards, vehicles, public transport, consent, utilities, animal care, and crafting.
- Transactional rollback, double-entry ledger and wallet-conservation checks, idempotency replay checks, and audit events.
- Unreal-side Bot QA controller and telemetry validation for navigation/movement/collision sessions.
- Guardian integration, test suites, reports, and an Unreal Engine 5.8 integration checklist.

## Run the Python QA suites

From the repository root:

```powershell
python -m compileall -q Tools/BotLab Tools/Health
python -m unittest discover -s Tools/BotLab/tests -p "test_*.py" -v
python Tools/BotLab/botlab.py --agents 64 --actions 250 --seed 20261121
python Tools/Health/ridge_guardian.py --project-root . --quick
```

For real Unreal Engine 5.8 validation, see [Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md](Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md) and run [Tools/BotLab/Run-UE58BotLabBuild.ps1](Tools/BotLab/Run-UE58BotLabBuild.ps1) on a machine with the matching UE 5.8 toolchain installed.

## Important validation boundaries

The Python tests validate the synthetic simulation and isolated interaction contracts. They do **not** prove that every gameplay feature is already implemented in Unreal.

The following remain unverified in this environment:

- Unreal C++ compilation/UHT, PIE, NavMesh baking, Dedicated Server, collision/physics behavior, and network replication.
- A completed live Unreal BotLab telemetry session.
- Production GIS tile ingestion and World Generator execution.
- PostgreSQL integration (the database integration test is skipped without an isolated development database).
- 500-concurrent-player load/soak testing.

The current release therefore remains **VERIFIED_WITH_LIMITATIONS**, not production-ready. Guardian must not silently mutate player wallets/ledger, inventory, property, ownership, rewards, production databases, credentials, authored Unreal assets, or project settings.

## Key V14 files

- [V14 test report](HEALTH_AUTOMATION_V14_STATUS_GE.md)
- [Release manifest](V14_BOTLAB_RELEASE_MANIFEST.json)
- [BotLab action catalog](Tools/BotLab/action_catalog.json)
- [Transactional interaction contracts](Tools/BotLab/interaction_contracts.py)
- [UE movement telemetry validator](Tools/BotLab/validate_ue_telemetry.py)
- [Interaction contract test suite](Tools/BotLab/tests/test_interaction_contracts.py)
- [QA reports](RIDGE_GIS/Data/QA/)


## V14 follow-up — UE source wiring

The BotLab V14 branch now includes the UE 5.8 project descriptor, Game/Editor/Server target definitions, module dependencies, a 24/24 source-wiring validator, two regression tests and a focused GitHub Actions workflow. This remains static verification only: the actual Unreal toolchain and PIE runtime are not available in this validation environment.

See `RIDGE_STAGE_2_4_EXECUTION_REPORT_GE.md` for the 2–4 stage report.


## Stage 2–4 CI verification

All three configured GitHub Actions workflows completed successfully on the current BotLab V14 branch. The ephemeral PostgreSQL 16 job applied migrations 001–003 and passed **23/23** backend/PostgreSQL integration tests. This was an isolated CI database, not a production or user database. Unreal Engine 5.8 compilation/UHT/PIE/NavMesh and runtime movement tests remain pending; stage 5 multiplayer/load testing is intentionally deferred.


BotLab V14 repeatability verification: **64,000 synthetic events across four deterministic seeds**, 0 invariant failures; 3,111 pairwise environment scenarios per seed. See `RIDGE_GIS/Data/QA/ridge_botlab_seed_matrix_v14.json`. This is synthetic model coverage, not exhaustive human-behavior proof or live Unreal NPC validation.


## Stage 5 — Multiplayer capacity preflight

Stage 5 work is maintained on the separate `codex/ridge-stage-5-multiplayer` branch so the V14 release branch and `main` remain unchanged.

- [Stage 5 multiplayer and capacity plan](docs/56_STAGE_5_MULTIPLAYER_CAPACITY_PLAN_GE.md)
- `Tools/LoadTest/ridge_api_load_test.mjs`: development-only virtual HTTP client runner (default 500 clients); refuses production and database-backed targets.
- `Tools/LoadTest/test_load_test.mjs`: load runner unit tests.
- `Tools/BotLab/tests/test_stage5_replication_contract.py`: static regression checks for existing Unreal replication declarations.
- `.github/workflows/ridge-stage5-preflight.yml`: static checks plus an isolated 500-client in-memory API preflight.

The API preflight is not a 500-player Unreal network test. C++ compilation/UHT, PIE, Dedicated Server runtime, network emulation, shard allocation/transfer, and the real 500-CCU Unreal soak test remain explicit acceptance gates. The 5 × 100 shard layout in the plan is a capacity-testing hypothesis, not a measured production limit.


### Stage 5 — first API preflight result (2026-11-23)

GitHub Actions Stage 5 preflight: **SUCCESS**. Regression gates: Python **52/52**, UE project static validation **24/24**, load-runner unit tests **6/6**, backend Node **22/22**. The isolated 500 virtual-user development API run completed **6,996 requests / 0 errors**, at **437.24 req/s**; p95 latency **0.56 ms**. This ran only against in-memory development storage. It is not a 500-player Unreal Engine network test; maximum simultaneous in-flight HTTP requests was 9. See the [workflow run](https://github.com/maisuradzee/Ridge/actions/runs/45125101490) and [Stage 5 plan/results](docs/56_STAGE_5_MULTIPLAYER_CAPACITY_PLAN_GE.md).


### Stage 5 increment — shard registry and session leases (2026-11-23)

The separate Stage 5 branch now contains a PostgreSQL-backed Dedicated Server registry and player session lease manager:

- migration 004 adds shard-instance and player-session tables;
- private endpoints register instances, update heartbeats, allocate region-specific sessions, claim leases and release sessions;
- per-player and per-region advisory locks plus a one-active-session index protect concurrent allocation;
- stale/offline shards are excluded; draining shards receive no new assignments;
- current region changes are explicitly rejected until a cross-region transfer workflow exists.

Validation: Stage 5 CI **SUCCESS** (Python 52/52, UE static 24/24, load unit 6/6, backend Node 33/33); PostgreSQL 16 live integration **35/35 PASS**, migrations 001–004; 500 virtual-user API preflight **6,994 requests / 0 errors / 437.23 req/s** against memory-only development storage.

This still does not prove 500 connected Unreal players. Player login/authentication, per-server credentials, client join tickets, Unreal registration/heartbeat wiring, real UE 5.8 runtime, cross-shard transfer, and real 500-CCU soak remain open.


### Unreal Dedicated Server control-plane wiring

The Stage 5 branch adds GameMode-driven shard registration on startup, 15-second heartbeat updates, and an offline heartbeat during EndPlay. Production mode now requires an HTTPS backend URL and an explicitly advertised non-loopback server host. See docs/57_UNREAL_DEDICATED_SERVER_REGISTRATION_GE.md.

This is source-level integration only until the Editor/Server targets compile and the server + two clients pass a real UE 5.8 network test. Player login/session allocation, signed join tickets, per-server credentials, reconnect and shard transfer remain open gates.


### Dedicated Server registration — static CI verified (2026-11-23)

- GameMode starts server-side shard registration and a 15-second heartbeat timer.
- The backend subsystem publishes current active player count and reports offline on EndPlay (including registration-in-flight shutdown fallback).
- Production configuration requires HTTPS and an explicitly configured non-loopback shard host.
- Stage 5 CI: Python/source regression **57/57**, UE static validator **24/24**, load unit tests **6/6**, backend Node **33/33**, all PASS.
- API preflight: **6,995 requests / 0 errors / 437.17 req/s**, p95 **1.17 ms** on in-memory development storage.

This is source-contract verification, not a real UE build. Unreal Engine 5.8 UBT/UHT, Dedicated Server runtime, two-client PIE, reconnect, and true 500-player load remain unverified. See the [Dedicated Server runbook](docs/57_UNREAL_DEDICATED_SERVER_REGISTRATION_GE.md).


### One-time join-ticket control

Stage 5 backend adds migration 005 for short-lived, single-use join tickets. The gateway receives a random 256-bit Base64URL ticket, while PostgreSQL stores only its SHA-256 digest. Tickets are bound to a specific shard, expire within 30 seconds (and never outlive their session lease), allow same-attempt idempotent retry, and reject reuse from another connection attempt. The legacy direct claim route is removed.

See docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md. This is not yet a full account login: verified identity-provider/gateway integration and Unreal PreLoginAsync/PostLogin/Logout wiring remain open.


### Unreal join-ticket enforcement

The Stage 5 Unreal GameMode source now binds one-time tickets to UE 5.8 PreLoginAsync -> InitNewPlayer -> PostLogin and releases sessions on Logout. Canonical backend identity is stored privately on the server-side PlayerState; the replicated RidgePublicId remains a separate public game identifier. Unverified connections are rejected/kicked.

Session allocation and ticket issuance now require a separate RIDGE_GATEWAY_TOKEN; shard operations retain RIDGE_SERVER_EVENT_TOKEN. The gateway implementation and account identity provider remain open. The bearer ticket is carried in the UE login options, so production also requires verified encrypted game-connection transport.

See docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md. C++ UBT/UHT and live UE 5.8 two-client runtime have not yet been executed.


### Join-ticket + Unreal login lifecycle — CI result (2026-11-23)

Latest commit e54e992e8307a1702a106e37a62a0ca631df948a passed:
- Python/BotLab/UE source regression: **66/66**
- UE project static validator: **24/24**
- Load-runner tests: **6/6**
- Backend Node tests: **37/37**
- PostgreSQL 16 migration 001–005 + live integration: **39/39 PASS**
- 500 virtual-client in-memory API preflight: **6,996 requests, 0 errors, 437.29 req/s**, p95 **0.80 ms**

Workflow evidence:
- Stage 5: https://github.com/maisuradzee/Ridge/actions/runs/45131346534
- PostgreSQL: https://github.com/maisuradzee/Ridge/actions/runs/45131346543

The UE project validator explicitly reports UBT/UHT build as NOT_RUN_STATIC_ONLY. No real UE 5.8 compile, two-client PIE or 500 connected-player soak is claimed. See docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md.


### Stable join-ticket retry and duplicate-account protection

Ticket issuance now returns a stable `claimAttemptId`, which the gateway must preserve and pass with the bearer ticket through Unreal connection options. PreLogin reuses this ID across retries; a duplicate pending/active backend player ID on the same shard is rejected. The schema enforces that ticket hash, expiry and claim attempt ID are stored together.


### Stable join-ticket retry hardening — CI verified (2026-11-23)

Revision `9d95b2276686c757e9fbccb85144b51d5f68db78` passed:
- Python/BotLab/UE source regression **66/66**
- UE project static validator **24/24**
- Load-runner tests **6/6**
- Backend Node tests **38 PASS / 0 FAIL / 2 SKIP**
- PostgreSQL 16 migrations 001–005 + live integration **40/40 PASS**
- 500 virtual-client in-memory API preflight **6,997 requests / 0 errors / 437.39 req/s**, p95 **0.47 ms**

Ticket issuance now returns a stable `claimAttemptId` stored with the ticket digest and expiry. Gateway passes it as `ridgeClaimAttemptId`; Unreal PreLogin reuses it across retries. A duplicate pending/active canonical player ID is rejected on the same shard.

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45132841698) · [PostgreSQL 16 integration](https://github.com/maisuradzee/Ridge/actions/runs/45132841779).

This is still source/static verification, not UBT/UHT compilation or a live Unreal network test. The 500 virtual users do not represent 500 connected Unreal players.


### Provider-agnostic OIDC public session gateway

The backend now exposes `POST /v1/gateway/session`. It verifies a signed RS256 OIDC JWT against configured HTTPS JWKS, derives an opaque canonical backend player ID from issuer + subject, allocates a healthy shard, and returns the one-time join ticket plus stable claimAttemptId in the Unreal connection options. Production requires OIDC configuration, PostgreSQL storage and a trusted HTTPS reverse proxy. See `docs/59_PUBLIC_OIDC_GATEWAY_GE.md`.

The endpoint is provider-agnostic, but the real provider tenant, authorization-code/redirect/MFA/account lifecycle, ingress rate limits, per-server credentials and encrypted Unreal game transport remain deployment/integration work. This is not yet a complete public account system.
