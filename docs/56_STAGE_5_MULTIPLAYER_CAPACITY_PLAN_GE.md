# RIDGE — ეტაპი 5: Multiplayer და 500 მოთამაშის დატვირთვის გეგმა

**საბაზისო ვერსია:** Saburtalo Vertical Slice v0.6.0 / BotLab V14.3  
**გეგმის სტატუსი:** IN PROGRESS — API capacity preflight მომზადებულია; Unreal multiplayer runtime gate ღიაა.  
**სამიზნე:** 500 ერთდროულად აქტიური მოთამაშე მთლიან RIDGE სამყაროში.

## 1. არსებული მდგომარეობა

ეტაპები 2–4 შესრულებულია იმ საზღვრებში, რომლებიც აღწერილია RIDGE_STAGE_2_4_EXECUTION_REPORT_GE.md-ში. GitHub Actions-ში BotLab და PostgreSQL 16 integration workflow-ები წარმატებით დასრულდა. Unreal Engine 5.8-ის რეალური compile/UHT/PIE/NavMesh/Dedicated Server runtime ჯერ არ დასტურდება.

Unreal source-ში უკვე არის:
- Character actor და movement replication;
- sprint state-ის server RPC და replicated state;
- Stamina-ის owner-only replication;
- PlayerState-ის public ID replication;
- GameState-ის world clock replication 2 Hz update frequency-ით;
- ცალკე Dedicated Server target.

ჯერ არ არსებობს ან რეალურ runtime-ში არ არის დადასტურებული:
- session allocation და matchmaking gateway;
- shard ownership / cross-shard transfer;
- production player authentication და reconnect recovery;
- 500 მოთამაშის რეალური Unreal network simulation;
- production-scale replication, bandwidth და CPU profiling.

## 2. არქიტექტურული გადაწყვეტილებები

### 2.1 500 CCU განისაზღვრება მთელი სერვერული ფენისთვის

500 CCU არის საერთო concurrent-player სამიზნე და არა მოთხოვნა, რომ ყველა მოთამაშე ერთ Unreal process-ში იყოს. საწყისი capacity-planning სცენარია 5 Dedicated Server shard × 100 მოთამაშე. ეს არის სატესტო ჰიპოთეზა და არა დადასტურებული საბოლოო ლიმიტი; რეალური ტესტის შედეგით shard size უნდა შეიცვალოს.

### 2.2 ავტორიტეტი და მონაცემთა ნაკადები

- Dedicated Server არის gameplay state-ის ავტორიტეტი: პოზიცია, მოძრაობა, შეჯახება, ინტერაქციების წინაპირობები, mission checkpoints და player-to-player მოქმედებები.
- Client აგზავნის input-სა და მოქმედების მოთხოვნას; client-ის მიერ მოწოდებული wallet balance, reward, inventory ownership ან hit result სანდო ფაქტად არ მიიღება.
- Backend იღებს მხოლოდ server-validated durable events-ს. Wallet/ledger/reward mutation არ უნდა შესრულდეს client-ის პირდაპირი მოთხოვნით.
- PostgreSQL ინახავს durable state-ს; Unreal server ინარჩუნებს მხოლოდ მიმდინარე simulation/session state-ს. ყოველ frame-ზე backend HTTP მოთხოვნა დაუშვებელია.
- Idempotency key და transactional ledger რჩება ფინანსური ოპერაციების სავალდებულო დაცვად.

### 2.3 Replication და სამყაროს მასშტაბირება

- ახლო მოთამაშეები და gameplay-critical actors იღებენ უფრო ხშირ update-ს; შორეული/უმოქმედო actors უნდა დაექვემდებარონ relevancy, dormancy და დაბალ update frequency-ს.
- World Partition / spatial cells და server-side interest management უნდა დაიტესტოს რეალურ Saburtalo map-ზე; მათი არსებობა მხოლოდ არქიტექტურის დოკუმენტში არ ჩაითვლება იმპლემენტაციად.
- Cross-shard გადაადგილება უნდა იყოს session transfer: ძველი shard აფიქსირებს server-side snapshot-ს, gateway ანიჭებს ახალ shard-ს, ახალი shard აღადგენს state-ს და მხოლოდ ამის შემდეგ იხსნება ძველი session.
- shard-ებს შორის wallet/ownership ოპერაციები backend-ის transaction boundary-ით სრულდება და არა პროცესებს შორის პირდაპირი memory access-ით.

### 2.4 იდენტობა და უსაფრთხოება

არსებული RidgePublicId server-side BeginPlay-ში იქმნება და replicate-დება. ის ჯერ არ არის production account identity ან authentication credential. Production login/session token-ის შექმნამდე ის მხოლოდ prototype-level public identifier-ად უნდა ჩაითვალოს. RIDGE_SERVER_EVENT_TOKEN არ უნდა მოხვდეს client build-ში, replicated property-ში, log-ში ან game asset/config file-ში.

## 3. ამ ცვლილებით დამატებული ხელსაწყოები

- Tools/LoadTest/ridge_api_load_test.mjs — development API-ის 500 virtual HTTP client capacity preflight.
- Tools/LoadTest/test_load_test.mjs — CLI, percentile, error-rate და threshold unit tests.
- Tools/BotLab/tests/test_stage5_replication_contract.py — Unreal source replication-ის სტატიკური regression checks.
- .github/workflows/ridge-stage5-preflight.yml — static suites და API load test GitHub Actions-ში.
- ეს დოკუმენტი — stage 5 architecture/acceptance plan.

Load runner იყენებს მხოლოდ GET მოთხოვნებს world state / player profile / player wallet endpoint-ებზე. ის მოითხოვს RIDGE_ENV=development და RIDGE_STORAGE=memory-ephemeral. Production და database-backed target-ებზე უსაფრთხოების მიზნით უარს ამბობს. CI-ის load სცენარში PostgreSQL ან production მონაცემები არ გამოიყენება.

## 4. API load preflight — საწყისი მიღების კრიტერიუმები

CI სცენარის პარამეტრები:
- 500 virtual HTTP clients;
- 15 წამიანი გაზომვის ფანჯარა;
- 3 წამიანი ramp-up;
- თითო client-ის დაახლოებით 1 წამი think-time;
- p95 latency მაქსიმუმ 1,500 ms;
- request error rate მაქსიმუმ 1%.

ეს ზღვრები მხოლოდ განვითარების API-ის საწყისი CI preflight-ია და არა production SLA. ტესტი ზომავს HTTP backend-ს; ის არ ქმნის 500 Unreal connection-ს და არ ამოწმებს actor replication-ს, movement bandwidth-ს, server tick-ს, physics-ს, NavMesh-ს ან packet loss-ს.

ანგარიშში ინახება request count, requests/sec, p50/p95/p99/max latency, HTTP status counts, error kinds და რეალურად დაკვირვებული concurrent HTTP requests.

## 5. Unreal runtime acceptance gates

### Gate A — compile და პატარა ქსელური ტოპოლოგია
1. Unreal Engine 5.8 Editor target compile და UHT წარმატებით უნდა დასრულდეს.
2. RIDGEServer target უნდა აიგოს და გაეშვას.
3. მინიმუმ 2 client PIE / Dedicated Server session-ში უნდა დადასტურდეს movement, sprint, crouch, PlayerState და world clock replication.
4. უნდა შემოწმდეს reconnect, server restart და stale RPC handling.
5. Network emulation-ით შემოწმდეს latency, jitter, packet loss და disconnect/reconnect.

### Gate B — shard capacity
1. 25, შემდეგ 50 და 100 რეალური UE clients თითო Dedicated Server-ზე.
2. თითო ეტაპზე CPU, RAM, server tick, bandwidth, actor count, replication time და dropped connection-ების გაზომვა.
3. AI/NPC density და nearby-player density-ის ცალკე სცენარები.
4. ფინანსური და მისიის მოვლენების duplicate/replay test.

### Gate C — საერთო 500 CCU
1. საწყისი სცენარი: 5 × 100 player shard, ან Gate B-ის გაზომვით მიღებული უკეთესი განაწილება.
2. 30 წუთიანი soak test და ramp-up/ramp-down.
3. shard transfer, reconnect და ერთი shard-ის დროებითი გათიშვის სცენარები.
4. 500 მოთამაშის განმავლობაში 0 duplicate reward, 0 ledger imbalance და 0 unauthorized durable mutation.
5. ყველა shard-ის report უნდა იყოს ერთმანეთთან შეკავშირებული საერთო test run ID-ით.

## 6. Production-ისკენ გადასვლის აკრძალვები

- API load preflight-ის PASS არ ნიშნავს, რომ 500 Unreal player მხარდაჭერილია.
- Static source tests არ არის C++ compile ან runtime proof.
- არ შეიცვალოს V14 release branch-ის production state; stage 5 მუშაობა ცალკე branch/PR-ში ინახება.
- load test არ უნდა გაეშვას production ან რეალურ user database-ზე.
- secrets, wallet, ledger, inventory, ownership, production database და authored Unreal assets ავტომატური QA-ს მიერ არ უნდა შეიცვალოს.

## 7. მიმდინარე გადაწყვეტილება

Stage 5-ის პირველი მიწოდება არის API load-test harness, source-level replication guardrails და CI preflight. შემდეგი აუცილებელი ბარიერი არის Windows გარემოში Unreal Engine 5.8 UBT/UHT/PIE/Dedicated Server-ის რეალური გაშვება. ამ გარემოს გარეშე საბოლოო 500 CCU multiplayer capacity ვერ გამოცხადდება.


## 8. შესრულებული CI preflight — 2026-11-23

GitHub Actions run #1 დასრულდა SUCCESS-ით:
[RIDGE Stage 5 Multiplayer Preflight](https://github.com/maisuradzee/Ridge/actions/runs/45125101490).

| შემოწმება | შედეგი |
|---|---:|
| BotLab + Unreal source + Stage 5 Python regression | 52/52 PASS |
| UE 5.8 project static validation | 24/24 PASS |
| Load runner unit tests | 6/6 PASS |
| Backend Node regression suite | 22/22 PASS |
| 500 virtual-user API preflight | PASS |
| HTTP requests | 6,996 |
| HTTP request failures | 0 |
| Requests per second | 437.24 |
| p50 / p95 / p99 latency | 0.32 / 0.56 / 1.62 ms |
| Maximum observed latency | 11.37 ms |
| Maximum simultaneous in-flight HTTP requests | 9 |

Load test შესრულდა 500 ლოგიკური virtual-user session-ით, 15-წამიანი ფანჯრით, 3-წამიანი ramp-up-ით და 1,000 ms think-time-ით. სამიზნე იყო მხოლოდ development API და memory-ephemeral storage; production და PostgreSQL არ გამოუყენებია. სრული JSON summary ინახება `RIDGE_GIS/Data/QA/ridge_stage5_api_preflight_20261123.json`-ში; ორიგინალი workflow artifact ხელმისაწვდომია [აქ](https://github.com/maisuradzee/Ridge/actions/runs/45125101490/artifacts/14794939132).

**მნიშვნელოვანი შეზღუდვა:** 500 virtual user არ ნიშნავს 500 ერთდროულად დაკავშირებულ Unreal მოთამაშეს. ამ ტესტში მაქსიმუმ 9 ერთდროული HTTP მოთხოვნა დაფიქსირდა. შესაბამისად, ეს ადასტურებს მხოლოდ development API-ის მსუბუქი read-only workload-ის გავლას. Unreal replication, Dedicated Server runtime, რეალური shard capacity და 500-CCU soak gate კვლავ ღიაა.


## 8. Dedicated Server registry and player session leases — Stage 5 increment

Migration `database/migrations/004_session_registry.sql` introduces two isolated tables:

- `ridge.dedicated_servers`: instance ID, region, advertised host/port, protocol version, maximum/live player counts, status and last heartbeat.
- `ridge.player_sessions`: player-to-shard reservation, session ID, lease expiry, connected/released/expired state.

The backend exposes private, game-server-token-protected routes:

| Method | Route | Purpose |
|---|---|---|
| POST | `/v1/internal/shards/register` | Register a Dedicated Server process |
| POST | `/v1/internal/shards/{serverId}/heartbeat` | Update live player count and ready/draining/offline state |
| GET | `/v1/internal/shards?region=ge-tbilisi` | List shard health and capacity |
| POST | `/v1/internal/players/{playerId}/session/allocate` | Reserve a slot in a healthy shard |
| POST | `/v1/internal/shards/{serverId}/players/{playerId}/claim` | Claim an unexpired player reservation |
| POST | `/v1/internal/shards/{serverId}/players/{playerId}/release` | Release the active reservation/session |

Operational rules:
- Default allocation lease and heartbeat-freshness window are each **45 seconds**.
- Maximum advertised capacity is bounded to **250 players per server instance**; capacity must be measured, not assumed.
- Allocation prefers the lowest-utilization healthy shard in the requested region. Reserved leases and connected sessions both consume capacity.
- A per-player advisory lock and partial unique index prevent one player from obtaining multiple active sessions. A per-region advisory lock serializes capacity selection; this avoids two concurrent allocations oversubscribing the same shard.
- A draining shard receives no new allocations but may claim existing live leases. An offline heartbeat expires its active sessions.
- Allocation replay returns the existing session for the same player and region while that shard remains healthy. A different region returns `SESSION_REGION_TRANSFER_REQUIRED`; cross-region transfer is not silently simulated.
- **serverId is a process-instance ID**. Generate a new unique ID for each Dedicated Server process boot; an ID with active sessions cannot be registered again.

These endpoints are not public player authentication. They require the existing internal server token. Before production, replace the shared token with per-server credentials/rotation, add a verified account/session gateway, and issue a signed or otherwise authenticated client join ticket. The current RidgePublicId is a prototype identifier, not an authentication credential.

## 9. Stage 5 validation results — 2026-11-23

| Gate | Result |
|---|---:|
| Python / BotLab / Unreal static source regression | 52/52 PASS |
| Unreal project static validator | 24/24 PASS |
| API load harness unit tests | 6/6 PASS |
| Backend Node regression (no database) | 33/33 PASS |
| PostgreSQL migrations 001–004 | PASS |
| Live backend + PostgreSQL integration | **35 PASS / 0 FAIL / 0 SKIP** |
| Session registry live integration | PASS |
| 500 virtual-user development HTTP preflight | PASS |

The API preflight used only in-memory development storage: **6,994 requests, 0 failures, 437.23 requests/second**, p50 **0.45 ms**, p95 **0.78 ms**, p99 **1.83 ms**, maximum **6.47 ms**. It observed at most **5 simultaneous in-flight HTTP requests**. These are virtual API users, not 500 Unreal Engine network connections.

Workflow evidence:
- [Stage 5 static/API preflight](https://github.com/maisuradzee/Ridge/actions/runs/45127547554)
- [PostgreSQL 16 integration, migrations 001–004](https://github.com/maisuradzee/Ridge/actions/runs/45127547471)

Committed machine-readable report: `RIDGE_GIS/Data/QA/ridge_stage5_session_registry_20261123.json`.

## 10. Remaining hard gates

- Player-facing authentication/session gateway and signed join ticket.
- Per-Dedicated-Server credentials, rotation and least-privilege access.
- Unreal GameMode/BackendSubsystem registration + heartbeat wiring, then real UE 5.8 UBT/UHT compile.
- Two-client PIE and Dedicated Server claim/reconnect behavior.
- Cross-region/cross-shard transfer workflow and recovery.
- 25/50/100 UE client capacity measurements and 500-CCU soak with server CPU, memory, tick, network bandwidth and replication profiling.

The current work is the backend control-plane foundation, not proof of a 500-player playable world.


### Join-ticket + Unreal login lifecycle (source wiring)

Migration 005 and the backend issue/claim endpoints are now connected in Unreal source through PreLoginAsync, InitNewPlayer, PostLogin and Logout. The server stores canonical verified player ID only in a non-replicated PlayerState field. Gateway allocation/issue routes now require a separate RIDGE_GATEWAY_TOKEN; Dedicated Server operations require RIDGE_SERVER_EVENT_TOKEN. See docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md.

This is source implementation, not a verified UE build/runtime. The gateway/identity provider, encrypted UE game-connection transport, UBT/UHT and real two-client Dedicated Server test remain release gates.


### Verified Stage 5 join-ticket and Unreal login CI (2026-11-23)

- Python/BotLab/UE source regression 66/66 PASS.
- UE project static validator 24/24 PASS; UBT/UHT was NOT RUN.
- Load harness 6/6 PASS; backend Node 37/37 PASS.
- PostgreSQL migration 001–005 and live integration 39 PASS / 0 FAIL / 0 SKIP.
- 500 virtual-client memory API preflight: 6,996 requests, zero failures, 437.29 req/s, p95 0.80 ms.

Stage workflow: https://github.com/maisuradzee/Ridge/actions/runs/45131346534
PostgreSQL workflow: https://github.com/maisuradzee/Ridge/actions/runs/45131346543

The load profile is not 500 connected Unreal clients. Real UE 5.8 build, UHT, two-client PIE, transport encryption, identity gateway and 500-CCU soak remain open release gates.


### Public OIDC gateway + per-instance credential lifecycle — latest verified state (2026-11-23)

The Stage 5 branch now contains:
- Public `POST /v1/gateway/session`, validating an RS256 OIDC token against configured HTTPS JWKS, deriving canonical identity from issuer + subject, and returning an opaque one-time shard join ticket with stable claimAttemptId.
- Migration 005 for hash-only join-ticket persistence and all-or-none hash/expiry/attempt constraints.
- Migration 006 for individual 256-bit Dedicated Server process credentials; only SHA-256 digests are persisted. Orchestrator-only provisioning, rotation and revocation endpoints are separate from player gateway and game-server roles.
- Production API listener guard: loopback/RFC1918/IPv6 ULA only; wildcard and public binds fail startup.
- PostgreSQL readiness includes the per-instance credential registry.

Latest commit `e2df4c454c332e9362d7e44ca4044a3f16c8058c`: Python source regression **72/72 PASS**; UE static validation **STATIC_PASS**; load unit **6/6 PASS**; backend Node **55 PASS / 0 FAIL / 2 SKIP**; PostgreSQL 16 migrations 001–006 and live suite **57 PASS / 0 FAIL / 0 SKIP**; 500 virtual-user in-memory API preflight **6,995 requests / 0 errors / 437.26 req/s**, p95 **0.82 ms**.

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45137196624) · [PostgreSQL 16 integration](https://github.com/maisuradzee/Ridge/actions/runs/45137196583).

No claim is made that UE 5.8 UBT/UHT/PIE, actual provider tenant/auth-code flow, TLS reverse proxy deployment, encrypted game transport or 500 connected Unreal players have been verified.


### Unreal client-to-shard handoff — source/static verified (2026-11-23)

URidgeSessionLoginSubsystem accepts a provider-issued OIDC access token from the caller, posts the region to the public /v1/gateway/session endpoint over HTTPS, validates host/port/ticket/claimAttemptId/expiry, then calls APlayerController::ClientTravel with the one-time join options. It contains no gateway, Dedicated Server or provisioning service credentials. The default Gateway URL is loopback-only development configuration.

Stage 5 workflow on f689c702c267a90486f329850d2b790131bb5a82: source regression **74/74 PASS**, UE static **STATIC_PASS**, load unit **6/6 PASS**, backend Node **55 PASS / 0 FAIL / 2 SKIP**, 500 virtual-user API preflight **6,996 requests / 0 errors / 437.15 req/s**, p95 **0.71 ms**.

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45138435495). PostgreSQL migrations 001–006/live backend **57/57 PASS** were verified on previous backend-only revision e2df4c454c332e9362d7e44ca4044a3f16c8058c; the client-only change adds no backend or migration changes.

Provider UI/PKCE, packaged client wiring, UE 5.8 UBT/UHT, two-client PIE, actual ClientTravel/PreLogin join, encrypted game transport and 500 connected Unreal client capacity remain unverified.


### Blueprint-accessible client login entry point — latest CI (2026-11-23)

URidgeSessionLoginSubsystem exposes a BlueprintCallable RequestAndConnectFromBlueprint function and BlueprintAssignable OnLoginAttemptCompleted event for the future login UI. The caller supplies a provider-issued access token; the subsystem requests a one-time session from the public OIDC Gateway, validates the ticket and starts ClientTravel. It does not implement the identity-provider browser/PKCE UI or token refresh.

Revision 4ce132707cb64ed53c34ec2d60aefec57dda5532: **75/75** source/regression PASS, UE static PASS, load unit 6/6 PASS, backend Node 55 PASS / 0 FAIL / 2 SKIP; 500 virtual-user in-memory API preflight **6,997 requests / 0 errors / 437.38 req/s**, p95 **0.49 ms**.

Evidence: [Stage 5 CI](https://github.com/maisuradzee/Ridge/actions/runs/45138993647). The separate PostgreSQL backend suite has previously passed migrations 001–006 with 57/57 tests. UBT/UHT, packaged client, provider UI, two-client PIE and actual game transport remain unverified.


### Latest source verification — 2026-11-23

Branch head 6075bb5a640a22561016848d6f0169035b9c7eca passed:
- Stage 5 source/static: **75/75 Python/BotLab/Unreal source**, UE static **STATIC_PASS**, load unit **6/6**, backend Node **55 PASS / 0 FAIL / 2 SKIP**.
- 500 virtual HTTP users: **6,995 requests / 0 errors / 437.18 req/s**, p50 **0.55 ms**, p95 **0.93 ms**, p99 **1.46 ms**, max **4.78 ms**, max in-flight **6**.
- PostgreSQL 16 migrations 001–006 and live suite: **57 PASS / 0 FAIL / 0 SKIP**.

Evidence: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45139177332) · [PostgreSQL](https://github.com/maisuradzee/Ridge/actions/runs/45139177246).

The load profile remains in-memory API traffic, not connected Unreal Engine clients. UBT/UHT, provider authorization/PKCE UI, packaged client login, true server travel/replication and encrypted game transport remain open.


### UE 5.8 Game/Editor/Server build gate — source verified (2026-11-23)

The local PowerShell build runner now checks the installed UE 5.8 version and builds the main `RIDGE` Game target and `RIDGEEditor` by default. Pass `-BuildDedicatedServer` to include `RIDGEServer`. Each target records its own log and a JSON build report under the QA directory. This runner has not yet been executed against the user's local Unreal installation.

The project static validator now reports **37/37 checks PASS**, including:
- all Game/Editor/Server target files and Http/Json module dependencies;
- client login UHT generated-header ordering, Blueprint entrypoint and result delegate;
- OIDC gateway Bearer request, ticket/attempt/expiry validation and ClientTravel;
- loopback-only development HTTP allowlist and no client-embedded service credentials;
- checked-in non-secret loopback Gateway configuration.

Latest CI on commit `55b2f1ccfe59cd3d97be1d941efc53d942406c77`: source regression **77/77 PASS**, validator **37/37 STATIC_PASS**, load unit **6/6**, backend Node **55 PASS / 0 FAIL / 2 SKIP**, virtual API **6,995 req / 0 errors / 437.31 req/s**, p95 **0.72 ms**. PostgreSQL 16 migrations 001–006/live suite **57 PASS / 0 FAIL / 0 SKIP**.

Evidence: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45145350622) · [PostgreSQL 16](https://github.com/maisuradzee/Ridge/actions/runs/45145350554).


### Concurrent login / ticket integrity hardening — latest verified (2026-11-23)

- A repeated or concurrent public Gateway request for a player with a reused allocated session is rejected as `409 PLAYER_SESSION_LOGIN_PENDING`; no new ticket is issued.
- Memory and PostgreSQL session registries refuse to overwrite a ticket that has not expired, returning `SESSION_JOIN_TICKET_ALREADY_ISSUED`.
- PostgreSQL selects the allocation row `FOR UPDATE` and checks the ticket expiry before writing a new ticket hash, preventing simultaneous issuance races across API processes.
- The integration test sends two overlapping public OIDC session requests and asserts one HTTP 201 plus one HTTP 409; the successful ticket remains claimable.
- PostgreSQL live integration asserts that a second issuance cannot invalidate the first ticket.

Verified on source commit `88b5b2da02c1b5109e5fcc04ffd905bcbba29e25`: Stage 5 **77/77 source PASS**, validator **37/37 STATIC_PASS**, backend **55 PASS / 0 FAIL / 2 SKIP**, virtual API **6,995 requests / 0 errors / 437.43 req/s**, PostgreSQL migrations 001–006 and live suite **57 PASS / 0 FAIL / 0 SKIP**.

Evidence: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45146481336) · [PostgreSQL](https://github.com/maisuradzee/Ridge/actions/runs/45146481678).


### Latest branch-head CI after concurrent-login hardening (2026-11-23)

On branch head `10b48cec244db236f0d81a9717535b53945042bd`:
- Source/regression **77/77 PASS**; UE project validator **37/37 STATIC_PASS**.
- Load runner **6/6 PASS**; backend Node **55 PASS / 0 FAIL / 2 SKIP**.
- 500 virtual API users: **6,995 requests / 0 errors / 437.30 req/s**, p50 **0.49 ms**, p95 **0.84 ms**, p99 **2.15 ms**, max **8.93 ms**, maximum in-flight **7**.
- PostgreSQL 16 migrations 001–006 and live suite **57 PASS / 0 FAIL / 0 SKIP**.

Evidence: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45147046969) · [PostgreSQL](https://github.com/maisuradzee/Ridge/actions/runs/45147046895).


### UE 5.8 Windows UBT/UHT build gate — 2026-11-24

- Build runner compiles RIDGE Game + RIDGEEditor by default and optionally RIDGEServer with -BuildDedicatedServer.
- The manual workflow .github/workflows/ridge-ue58-windows-build.yml requires a restricted self-hosted Windows X64 runner labelled ridge-ue58 and a machine-level RIDGE_UE_ROOT.
- Successful builds upload one JSON report and per-target logs as ridge-ue58-windows-build. Linux static CI is not represented as an Unreal compile.
- Stage 5 Linux verification on branch snapshot 79a450e3fed39c0a38b3d4b2f400b896dcee36ea: source/regression 77/77 PASS; UE static 37/37 PASS; load unit 6/6 PASS; backend Node 55 PASS / 0 FAIL / 2 SKIP; PostgreSQL 16 migrations 001–006/live 57 PASS / 0 FAIL / 0 SKIP; 500 virtual HTTP clients 6,995 requests / 0 errors / 437.24 req/s.
- The Windows workflow is ready but has not run because a ridge-ue58 runner is not yet confirmed online.

Guide: docs/62_UE58_WINDOWS_BUILD_GATE_GE.md. Static validation report is uploaded by CI as ridge-ue-project-static-validation; generated local build reports and logs are ignored by Git.
