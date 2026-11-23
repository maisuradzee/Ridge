# RIDGE — ერთჯერადი Join Ticket და Dedicated Server claim

**ეტაპი:** Stage 5 / player session entry  
**მდგომარეობა:** Backend registry + authenticated internal HTTP routes and UE PreLogin/PostLogin/Logout source wiring implemented; real UE runtime validation remains open.  
**უსაფრთხოების პრინციპი:** კლიენტი არ წყვეტს საკუთარ player ID-ს, server ID-ს ან session ID-ს. მოთამაშის იდენტობა დადასტურებული gateway-იდან მოდის.

## 1. შესვლის ნაკადი

1. მოთამაშე გადის ანგარიშის ავტორიზაციას სანდო identity provider/gateway-ში.
2. Gateway იღებს verified player ID-ს და იძახებს POST /v1/internal/players/{playerId}/session/allocate.
3. Registry აბრუნებს რეგიონში ყველაზე ნაკლებად დატვირთული ჯანმრთელი shard-ის მისამართსა და დროებით session reservation-ს.
4. Gateway იძახებს POST /v1/internal/players/{playerId}/session/join-ticket სხეულით sessionId და serverId.
5. Registry ქმნის 256-bit random bearer ticket-ს, აბრუნებს მას მხოლოდ ერთხელ და PostgreSQL-ში ინახავს მხოლოდ SHA-256 hash-ს.
6. Gateway კლიენტს აწვდის Dedicated Server-ის მისამართს, ticket-ს და მის სტაბილურ claimAttemptId-ს. ორივე მნიშვნელობა გადაეცემა UE connection options-ით (ridgeJoinTicket და ridgeClaimAttemptId).
7. შესაბამისი Dedicated Server PreLoginAsync-ში აგზავნის ticket-ს და claimAttemptId-ს POST /v1/internal/shards/{serverId}/join/claim-ზე.
8. Backend ამოწმებს ორივე მნიშვნელობას, allocated session-ს connected-ად ცვლის და აბრუნებს verified playerId + sessionId. იმავე ID-ით განმეორებითი claim უსაფრთხო replay-ია, განსხვავებული ID კი იბლოკება.
9. მხოლოდ successful claim-ის შემდეგ GameMode უშვებს მოთამაშეს და PlayerState-ში წერს verified identity-ს.
10. Logout/disconnect-ზე Dedicated Server იძახებს session release endpoint-ს. თუ სერვერი crash-ით გაითიშა, offline heartbeat/lease recovery ამცირებს stale reservation-ს.

## 2. Ticket-ის მახასიათებლები

- 32 random bytes → 43-character Base64URL string.
- PostgreSQL-ში ინახება მხოლოდ 64-character lowercase SHA-256 digest; raw bearer ticket არ ინახება.
- Default ticket TTL: 30 წამი; რეალური expiry არ შეიძლება აღემატებოდეს parent session lease-ს (default 45 წამი).
- ახალი ticket-ის გაცემა იმავე allocation-ზე ძველ ticket-ს აუქმებს.
- Ticket მიბმულია კონკრეტულ serverId-ზე; სხვა shard-ზე claim უარყოფილია.
- პირველი claim ატომურად ცვლის session-ს allocated-იდან connected-ში.
- Ticket-ის გაცემისას registry ქმნის სტაბილურ random UUID claimAttemptId-ს და ინახავს მას ticket-ის hash/expiry-სთან ერთად.
- Gateway ორივე მნიშვნელობას უცვლელად ინახავს და client-ს გადასცემს; PreLoginAsync ახალ ID-ს აღარ ქმნის.
- იმავე claimAttemptId-ით retry idempotent-ია, რათა DB claim-ის შემდეგ HTTP response-ის დაკარგვამ მოთამაშე არ დაბლოკოს.
- სხვა ID-ით claim იწვევს JOIN_TICKET_CLAIM_ATTEMPT_MISMATCH (ჯერ არ გამოყენებულ ticket-ზე) ან JOIN_TICKET_ALREADY_USED-ს (უკვე დაკავშირებულ სესიაზე).
- Ticket-ის დასრულების ან session release/offline/expiry შემდეგ ხელახალი გამოყენება შეუძლებელია.

## 3. შიდა API

ყველა endpoint მოითხოვს x-ridge-server-token და არ არის client-facing API.

| Method | Route | მიზანი |
|---|---|---|
| POST | /v1/internal/players/{playerId}/session/allocate | verified player-ისთვის shard reservation |
| POST | /v1/internal/players/{playerId}/session/join-ticket | მოკლევადიანი ერთჯერადი ticket |
| POST | /v1/internal/shards/{serverId}/join/claim | შესაბამის shard-ზე ticket-ის consume/claim |
| POST | /v1/internal/shards/{serverId}/players/{playerId}/release | დაკავშირებული session-ის გათავისუფლება |

Legacy direct-claim route, რომელიც playerId + sessionId-ით პირდაპირ ცვლიდა session-ს, ამოღებულია. კლიენტმა არ უნდა მიიღოს internal token ან ამ endpoint-ების პირდაპირ გამოძახების შესაძლებლობა.

## 4. Migration და CI

- database/migrations/005_session_join_tickets.sql
  - join_ticket_hash
  - join_ticket_expires_at
  - join_attempt_id
- database/migrations/006_dedicated_server_credentials.sql
  - per-instance server credential UUID
  - SHA-256 token hash only
  - expiry and revocation timestamps
  - ticket hash unique index და expiry index
- Memory registry tests ამოწმებს expiry, replacement ticket, same-claim replay, different-connection reuse rejection და shard binding.
- PostgreSQL integration test ამოწმებს რეალურ DB-ში hash-only storage-ს, claim atomicity-ს და same-attempt replay-ს.
- HTTP test ამოწმებს internal token, wrong-shard rejection, legacy route removal და ticket reuse policy-ს.

## 5. მნიშვნელოვანი შეზღუდვები

ეს increment ქმნის უსაფრთხო server-join primitive-ს, მაგრამ სრულ login system-ს ჯერ არ ქმნის.

ჯერ დასამატებელია:
- identity provider-ის რეალური integration (მაგ. account/email/OAuth login და verified player ID);
- gateway/matchmaking service, რომელიც მხოლოდ verified identity-ით აკეთებს allocation + ticket issuance-ს;
- gateway-ისა და Dedicated Server-ების განცალკევებული service credentials, rotation/revocation და audit;
- Unreal Engine PreLoginAsync/PostLogin/Logout C++ wiring;
- ticket-ის გადაცემა connection options-იდან და successful claim-ის შემდეგ verified PlayerState identity;
- ორი client-ის რეალური PIE/Dedicated Server test.

Gateway და Dedicated Server ცალკე shared role token-ებს იყენებენ: RIDGE_GATEWAY_TOKEN და RIDGE_SERVER_EVENT_TOKEN. ეს ამცირებს უფლებების გადაკვეთის რისკს, მაგრამ ჯერ არ იძლევა თითოეული server instance-ის ინდივიდუალურ credential-ს ან rotation/revocation-ს. Production-მდე ეს per-server credential-ებით უნდა ჩანაცვლდეს და UE game-connection transport-ის encryption-იც უნდა დადასტურდეს.

მნიშვნელოვანი: RidgePublicId კვლავ prototype identifier-ია, სანამ verified account identity არ მიეწოდება gateway-ს. Join ticket არ ცვლის ანგარიშის ავტორიზაციას — ის მხოლოდ ერთჯერადი, მოკლევადიანი დაშვებაა კონკრეტულ Dedicated Server session-ზე.


## 6. Unreal Engine server login lifecycle — source wiring added

The Stage 5 Unreal GameMode now wires the backend one-time ticket to the Unreal login lifecycle:

- PreLoginAsync first invokes Super::PreLoginAsync, preserving the engine's normal pre-login checks and event broadcast, then validates ridgeJoinTicket plus the gateway-issued ridgeClaimAttemptId against the backend asynchronously.
- Same-ticket/same-attempt PreLogin retries are idempotent. A different connection attempt cannot reuse the ticket.
- The GameMode refuses a second pending/active connection for the same canonical backend Player ID on that shard.
- A successful server claim is held in a short-lived in-memory pending map (25 seconds).
- InitNewPlayer requires the same ticket to have a matching backend-verified claim; missing/expired claims are rejected.
- PostLogin sets the canonical backend identity on the server-only PlayerState field. Unexpected unverified connections are kicked through GameSession->KickPlayer.
- Logout releases the exact player/session pair through the Dedicated Server API.
- A 5-second cleanup timer releases verified claims that were never promoted to a controller; server shutdown reports the shard offline, which expires any remaining sessions.

RidgePublicId remains the replicated public game ID. The canonical account/player ID is stored in a private, non-replicated VerifiedPlayerId field and is only read by server-side backend calls.

The backend separates the service roles:
- OIDC Bearer token: public player identity proof; verified against configured issuer/audience/JWKS.
- RIDGE_GATEWAY_TOKEN / x-ridge-gateway-token: trusted internal session allocation and ticket issuance.
- RIDGE_SERVER_PROVISIONING_TOKEN / x-ridge-provisioning-token: orchestrator-only issuance, rotation and revocation of per-instance server credentials.
- RIDGE_SERVER_EVENT_TOKEN / x-ridge-server-token: unique credential for one Dedicated Server process, paired with x-ridge-server-id.

The provisioning token exists only in the control-plane/orchestrator and Backend API configuration. Dedicated Server processes receive only their own per-instance token. Production does not accept the old shared server-token fallback. The public OIDC session endpoint and one-time ticket flow are implemented; the real provider tenant/authorization-code configuration remains a deployment integration step. See `docs/60_PER_INSTANCE_SERVER_CREDENTIALS_GE.md`.

### Production transport caution

The bearer ticket is passed through Unreal's ridgeJoinTicket connection option and is short-lived (30 seconds). The application-side registry validation is single-use, but a production deployment must also verify encrypted/protected Unreal connection transport for the initial login options. HTTPS to the backend does not encrypt the separate UE game connection by itself.

### Current acceptance boundary

The C++ overrides and source-level contracts are committed and are being checked by static CI. This does not prove Unreal Engine 5.8 UBT/UHT compilation or a live network join. Still required: Windows UE 5.8 Editor/Server build, two-client PIE/Dedicated Server, rejection of a ticketless client, successful per-instance credential authentication, successful claim, public PlayerState replication, logout release, reconnect, and server shutdown recovery.


## 7. CI results — 2026-11-23

The latest verified OIDC gateway revision `d0490b75aa471e64da986e72627a74790ee2abd1` passed:

- Stage 5 Multiplayer Preflight: https://github.com/maisuradzee/Ridge/actions/runs/45134162859
- PostgreSQL 16 Integration: https://github.com/maisuradzee/Ridge/actions/runs/45134168625

| Gate | Result |
|---|---:|
| Python / BotLab / Unreal source regression | 69/69 PASS |
| Unreal project static validator | PASS |
| Load-runner unit tests | 6/6 PASS |
| Backend Node suite | 51 PASS / 0 FAIL / 2 SKIP |
| PostgreSQL migrations 001–005 | PASS |
| Backend + live PostgreSQL suite | 53 PASS / 0 FAIL / 0 SKIP |
| 500 virtual-client in-memory API preflight | 6,995 requests / 0 failures |

The 15-second in-memory development API preflight recorded 437.4 requests/second, p50 0.24 ms, p95 0.45 ms, p99 1.17 ms and max 4.09 ms; maximum observed in-flight HTTP requests was 6. It is not a 500-player Unreal network test.

Machine-readable reports: `RIDGE_GIS/Data/QA/ridge_stage5_oidc_gateway_20261123.json` and `RIDGE_GIS/Data/QA/ridge_stage5_join_ticket_unreal_login_20261123.json`.

UE 5.8 UBT/UHT was not run. The actual provider tenant, authorization-code flow, production TLS ingress, encrypted Unreal game transport, live two-client PIE/Dedicated Server, reconnect and 500 connected Unreal player soak remain open.


## 8. Stable claim ID და duplicate-account protection

Ticket issuance response შეიცავს `claimAttemptId`-ს. Gateway-მა უნდა გადასცეს ორივე მნიშვნელობა:

`?ridgeJoinTicket=<ticket>?ridgeClaimAttemptId=<uuid>`

Unreal `PreLoginAsync` ორივეს კითხულობს. Claim ID-ის შექმნა Gateway/registry-ის მხარეს ხდება, არა PreLogin callback-ის შიგნით; ამიტომ იგივე join URL-ის ხელახლა ცდა DB claim-ის შემდეგ დაკარგული HTTP response-ის შემთხვევაშიც idempotent რჩება.

GameMode ინახავს verified, pending და active claims-ს. ერთი canonical backend Player ID-ის მეორე პარალელური/აქტიური connection იმავე shard-ზე უარყოფილია. claimAttemptId არის idempotency binding და არა დამოუკიდებელი authentication factor; bearer ticket კვლავ აუცილებელია.

Migration 005 ამოწმებს, რომ `join_ticket_hash`, `join_ticket_expires_at` და `join_attempt_id` ან სამივე ერთად იყოს მითითებული, ან არცერთი.


## 9. Public OIDC player session gateway

The backend now exposes `POST /v1/gateway/session`. It accepts a verified OIDC JWT for the configured RIDGE audience, derives the canonical backend identity from issuer + subject, allocates a healthy shard, issues a short-lived one-time ticket, and returns the connection host/port plus both `ridgeJoinTicket` and stable `ridgeClaimAttemptId` options.

Production requires `RIDGE_OIDC_ISSUER`, `RIDGE_OIDC_AUDIENCE`, `RIDGE_OIDC_JWKS_URL`, PostgreSQL storage and a trusted HTTPS reverse proxy (`RIDGE_TRUST_PROXY=true`). The reverse proxy must overwrite X-Forwarded-Proto and the Node listener must not be publicly reachable. The actual provider's authorization-code/redirect/MFA/account-recovery setup is not supplied by the repository; it must be configured at deployment.

Runbook: `docs/59_PUBLIC_OIDC_GATEWAY_GE.md`.


## 10. Concurrent gateway retries and one-ticket-per-active-attempt

An allocated player session may have at most one unexpired join ticket. A second public Gateway request which reuses that pending allocation receives `409 PLAYER_SESSION_LOGIN_PENDING`; it must not be used to issue another ticket. At the registry layer, a second ticket issuance before the first ticket expires is rejected as `SESSION_JOIN_TICKET_ALREADY_ISSUED`.

For PostgreSQL this check occurs after selecting the session row `FOR UPDATE`, so concurrent API processes cannot both replace the ticket. After expiry or explicit session cleanup, a fresh login attempt may allocate a new session/ticket.

The concurrent OIDC integration test requires exactly one request to return 201 and one to return 409, then claims the first ticket successfully. Latest source/DB CI: [Stage 5](https://github.com/maisuradzee/Ridge/actions/runs/45146481336) and [PostgreSQL 16](https://github.com/maisuradzee/Ridge/actions/runs/45146481678).
