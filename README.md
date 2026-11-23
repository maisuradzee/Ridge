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

This still does not prove 500 connected Unreal players. OIDC gateway, join-ticket source flow and per-instance credential registry are implemented; actual provider tenant/PKCE/MFA setup, production secret-manager orchestration and credential audit, real UE 5.8 runtime, encrypted game transport, cross-shard transfer, and true 500-CCU soak remain open.


### Unreal Dedicated Server control-plane wiring

The Stage 5 branch adds GameMode-driven shard registration on startup, 15-second heartbeat updates, and an offline heartbeat during EndPlay. Production mode now requires an HTTPS backend URL and an explicitly advertised non-loopback server host. See docs/57_UNREAL_DEDICATED_SERVER_REGISTRATION_GE.md.

This is source-level integration only until the Editor/Server targets compile and the server + two clients pass a real UE 5.8 network test. OIDC-backed session allocation, signed join-ticket flow and per-instance credential source are implemented; actual provider setup, production secret-manager orchestration, reconnect soak and shard transfer remain open gates.


### Dedicated Server registration — static CI verified (2026-11-23)

- GameMode starts server-side shard registration and a 15-second heartbeat timer.
- The backend subsystem publishes current active player count and reports offline on EndPlay (including registration-in-flight shutdown fallback).
- Production configuration requires HTTPS and an explicitly configured non-loopback shard host.
- Stage 5 CI: Python/source regression **57/57**, UE static validator **24/24**, load unit tests **6/6**, backend Node **33/33**, all PASS.
- API preflight: **6,995 requests / 0 errors / 437.17 req/s**, p95 **1.17 ms** on in-memory development storage.

This is source-contract verification, not a real UE build. Unreal Engine 5.8 UBT/UHT, Dedicated Server runtime, two-client PIE, reconnect, and true 500-player load remain unverified. See the [Dedicated Server runbook](docs/57_UNREAL_DEDICATED_SERVER_REGISTRATION_GE.md).


### One-time join-ticket control

Stage 5 backend adds migration 005 for short-lived, single-use join tickets. The gateway receives a random 256-bit Base64URL ticket, while PostgreSQL stores only its SHA-256 digest. Tickets are bound to a specific shard, expire within 30 seconds (and never outlive their session lease), allow same-attempt idempotent retry, and reject reuse from another connection attempt. The legacy direct claim route is removed.

See docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md and docs/59_PUBLIC_OIDC_GATEWAY_GE.md. Provider-agnostic OIDC JWT verification and public session ticket issuance are implemented; actual provider tenant/authorization-code/PKCE and live UE 5.8 runtime remain open.


### Unreal join-ticket enforcement

The Stage 5 Unreal GameMode source now binds one-time tickets to UE 5.8 PreLoginAsync -> InitNewPlayer -> PostLogin and releases sessions on Logout. Canonical backend identity is stored privately on the server-side PlayerState; the replicated RidgePublicId remains a separate public game identifier. Unverified connections are rejected/kicked.

Session allocation and ticket issuance use a separate RIDGE_GATEWAY_TOKEN. The orchestrator alone holds RIDGE_SERVER_PROVISIONING_TOKEN; each shard receives only its own RIDGE_SERVER_EVENT_TOKEN tied to RIDGE_SERVER_INSTANCE_ID. Production has no shared server-token fallback. The real provider tenant and authorization-code/PKCE/MFA account lifecycle remain deployment work. The bearer ticket is carried in UE login options, so production also requires verified encrypted game-connection transport.

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

The endpoint is provider-agnostic, but the real provider tenant, authorization-code/redirect/MFA/account lifecycle, ingress rate limits, production secret-manager provisioning/audit and encrypted Unreal game transport remain deployment/integration work. This is not yet a complete public account system.


### OIDC session gateway — CI verified (2026-11-23)

Revision `d0490b75aa471e64da986e72627a74790ee2abd1` passed:
- Python/BotLab/Unreal source regression: **69/69**
- Unreal project static validation: **PASS**
- Load-runner unit tests: **6/6**
- Backend Node suite: **51 PASS / 0 FAIL / 2 SKIP**
- PostgreSQL 16 migrations 001–005 + live backend integration: **53/53 PASS**
- 500 virtual-client in-memory API preflight: **6,995 requests / 0 errors / 437.4 req/s**, p95 **0.45 ms**

The provider-agnostic `POST /v1/gateway/session` verifies RS256 OIDC JWTs against configured JWKS, derives an opaque canonical player ID from issuer + subject, allocates a healthy shard and returns a one-time ticket plus stable claim attempt ID. Production fails closed without OIDC config, PostgreSQL and a trusted HTTPS proxy.

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45134162859) · [PostgreSQL 16 integration](https://github.com/maisuradzee/Ridge/actions/runs/45134168625) · [OIDC gateway runbook](docs/59_PUBLIC_OIDC_GATEWAY_GE.md).

This does not yet configure an actual identity-provider tenant or authorization-code flow, run UE 5.8 UBT/UHT, verify encrypted Unreal connection transport, run live two-client PIE, or prove 500 connected Unreal players. The branch stays Draft.


### Per-instance Dedicated Server credentials — Stage 5

Production shard authentication now uses a unique 256-bit token per `RIDGE_SERVER_INSTANCE_ID`. The orchestrator receives the token once from the provisioning API; PostgreSQL stores only its SHA-256 hash. Credential rotation invalidates the previous token immediately, and revocation affects only the selected instance. The old shared-token compatibility path is development-only.

Migration 006 adds the credential registry. Production requires `RIDGE_SERVER_PROVISIONING_TOKEN` in the control plane and never passes it to game-server processes. See `docs/60_PER_INSTANCE_SERVER_CREDENTIALS_GE.md`.


### Production gateway hardening — latest CI (2026-11-23)

Production API startup now rejects wildcard and public listener addresses, allowing only loopback, RFC1918 IPv4 and IPv6 ULA bind addresses. PostgreSQL readiness also checks the per-instance server credential registry.

Latest commit `e2df4c454c332e9362d7e44ca4044a3f16c8058c`:
- Python/BotLab/Unreal source regression: **72/72 PASS**
- UE project static validator: **STATIC_PASS** (UBT/UHT not run)
- Load unit: **6/6 PASS**
- Backend Node: **55 PASS / 0 FAIL / 2 SKIP**
- PostgreSQL 16 live suite, migrations 001–006: **57 PASS / 0 FAIL / 0 SKIP**
- 500 virtual API preflight: **6,995 requests, 0 failures, 437.26 req/s**, p95 **0.82 ms**

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45137196624) · [PostgreSQL 16](https://github.com/maisuradzee/Ridge/actions/runs/45137196583).

Real UE 5.8 build/runtime, actual identity provider deployment, secret manager rollout, TLS ingress, encrypted Unreal game transport and 500-CCU Unreal soak remain unverified.


Client login transport accepts HTTPS or exact loopback-only HTTP in development; public/prefix-lookalike HTTP origins are rejected. See `docs/61_UNREAL_CLIENT_SESSION_HANDOFF_GE.md`.


### Client OIDC-to-Dedicated-Server travel — Stage 5 source verified

The new URidgeSessionLoginSubsystem posts the provider-issued OIDC Bearer token to the public Gateway, validates the short-lived shard ticket and stable claim attempt, then starts APlayerController::ClientTravel. Client code has no internal service tokens. It permits HTTPS in production and exact loopback-only HTTP for local development.

CI: [Stage 5 Preflight](https://github.com/maisuradzee/Ridge/actions/runs/45138435495) — **74/74 source/regression**, UE static **PASS**, **6/6** load unit, backend **55 PASS / 0 FAIL / 2 SKIP**, API preflight **6,996 requests / 0 errors / 437.15 req/s**, p95 **0.71 ms**. This is not UBT/UHT or a real UE travel/network test. See docs/61_UNREAL_CLIENT_SESSION_HANDOFF_GE.md.


The client subsystem also exposes a Blueprint-callable UI entry point and a Blueprint-assignable result event, while leaving provider token acquisition/refresh to the selected identity-provider integration.


### Blueprint login UI entry point — verified source contract

The client session subsystem now exposes RequestAndConnectFromBlueprint plus OnLoginAttemptCompleted. The future login widget can submit a provider-issued OIDC token and receive the result through a Blueprint event; provider sign-in/PKCE and token refresh remain provider integration work.

Latest Stage 5 CI: [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45138993647) — Python/Unreal source **75/75 PASS**, UE static **PASS**, load unit **6/6 PASS**, backend Node **55 PASS / 0 FAIL / 2 SKIP**, 500 virtual API preflight **6,997 requests / 0 errors / 437.38 req/s**, p95 **0.49 ms**. UBT/UHT and real UE runtime are not proven.


### Latest Stage 5 verification — Blueprint OIDC login path

On branch head 6075bb5a640a22561016848d6f0169035b9c7eca:
- [Stage 5 Multiplayer Preflight](https://github.com/maisuradzee/Ridge/actions/runs/45139177332): **SUCCESS**
- Python/BotLab/Unreal source regression: **75/75 PASS**
- Unreal project static validator: **STATIC_PASS** (UBT/UHT not run)
- Load runner unit: **6/6 PASS**
- Backend Node: **55 PASS / 0 FAIL / 2 SKIP**
- 500 virtual-user development API preflight: **6,995 requests / 0 failures / 437.18 req/s**; p50 **0.55 ms**, p95 **0.93 ms**, p99 **1.46 ms**, max **4.78 ms**, max in-flight **6**
- [PostgreSQL 16 integration, migrations 001–006](https://github.com/maisuradzee/Ridge/actions/runs/45139177246): **57 PASS / 0 FAIL / 0 SKIP**

This verifies source/static contracts and API/backend integration only. UBT/UHT, external OIDC provider UI/PKCE, packaged client travel, encrypted Unreal game transport and true 500-player Unreal soak remain open.


### UE 5.8 local build gate — source/static verified

`Tools/BotLab/Run-UE58BotLabBuild.ps1` now builds `RIDGE` Game and `RIDGEEditor` by default; `-BuildDedicatedServer` adds `RIDGEServer`. It checks the installed Engine version, writes per-target logs and produces a machine-readable JSON build report. The static project validator now has 37 checks, including the client session login subsystem's UHT include ordering, Blueprint entry/event, Bearer gateway request, ticket/expiry validation, ClientTravel wiring, loopback HTTP allowlist and absence of server/gateway secrets.

Latest commit `55b2f1ccfe59cd3d97be1d941efc53d942406c77`:
- Python/BotLab/Unreal source regression: **77/77 PASS**
- Unreal project validator: **37/37 STATIC_PASS**
- Load-runner tests: **6/6 PASS**
- Backend Node: **55 PASS / 0 FAIL / 2 SKIP**
- 500 virtual-user in-memory development API: **6,995 requests / 0 failures / 437.31 req/s**, p50 **0.41 ms**, p95 **0.72 ms**, p99 **2.50 ms**, max **7.33 ms**, max in-flight **6**
- PostgreSQL 16 migrations 001–006/live suite: **57 PASS / 0 FAIL / 0 SKIP**

CI: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45145350622) · [PostgreSQL 16](https://github.com/maisuradzee/Ridge/actions/runs/45145350554).

The build script has **not** been run against a local Unreal Engine installation; UBT/UHT and runtime remain unverified until executed on the UE 5.8 workstation. See `Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md`.


### Concurrent login and join-ticket replacement guard — verified

A second concurrent login for an account with an allocated/in-flight session now receives **409 PLAYER_SESSION_LOGIN_PENDING**; it cannot replace the first request's join ticket. The session registry independently rejects issuing another ticket while the existing ticket remains unexpired (**SESSION_JOIN_TICKET_ALREADY_ISSUED**). The PostgreSQL implementation checks this under a row lock.

Latest Stage 5 run on source commit 88b5b2da02c1b5109e5fcc04ffd905bcbba29e25: **77/77 source**, UE static **37/37**, load unit **6/6**, backend **55 PASS / 0 FAIL / 2 SKIP**, API preflight **6,995 requests / 0 errors / 437.43 req/s**. PostgreSQL migrations 001–006/live suite: **57 PASS / 0 FAIL / 0 SKIP**.

Evidence: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45146481336) · [PostgreSQL 16](https://github.com/maisuradzee/Ridge/actions/runs/45146481678).
