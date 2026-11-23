# RIDGE — ერთჯერადი Join Ticket და Dedicated Server claim

**ეტაპი:** Stage 5 / player session entry  
**მდგომარეობა:** Backend registry + authenticated internal HTTP routes implemented; UE PreLogin/PostLogin/Logout wiring is the next increment.  
**უსაფრთხოების პრინციპი:** კლიენტი არ წყვეტს საკუთარ player ID-ს, server ID-ს ან session ID-ს. მოთამაშის იდენტობა დადასტურებული gateway-იდან მოდის.

## 1. შესვლის ნაკადი

1. მოთამაშე გადის ანგარიშის ავტორიზაციას სანდო identity provider/gateway-ში.
2. Gateway იღებს verified player ID-ს და იძახებს POST /v1/internal/players/{playerId}/session/allocate.
3. Registry აბრუნებს რეგიონში ყველაზე ნაკლებად დატვირთული ჯანმრთელი shard-ის მისამართსა და დროებით session reservation-ს.
4. Gateway იძახებს POST /v1/internal/players/{playerId}/session/join-ticket სხეულით sessionId და serverId.
5. Registry ქმნის 256-bit random bearer ticket-ს, აბრუნებს მას მხოლოდ ერთხელ და PostgreSQL-ში ინახავს მხოლოდ SHA-256 hash-ს.
6. Gateway კლიენტს აწვდის Dedicated Server-ის მისამართსა და ticket-ს. Ticket გადაეცემა UE connection options-ით (ridgeJoinTicket).
7. შესაბამისი Dedicated Server PreLoginAsync-ში აგზავნის ticket-ს POST /v1/internal/shards/{serverId}/join/claim-ზე.
8. Backend ticket-ს ამოწმებს, allocated session-ს connected-ად ცვლის და აბრუნებს verified playerId + sessionId.
9. მხოლოდ successful claim-ის შემდეგ GameMode უშვებს მოთამაშეს და PlayerState-ში წერს verified identity-ს.
10. Logout/disconnect-ზე Dedicated Server იძახებს session release endpoint-ს. თუ სერვერი crash-ით გაითიშა, offline heartbeat/lease recovery ამცირებს stale reservation-ს.

## 2. Ticket-ის მახასიათებლები

- 32 random bytes → 43-character Base64URL string.
- PostgreSQL-ში ინახება მხოლოდ 64-character lowercase SHA-256 digest; raw bearer ticket არ ინახება.
- Default ticket TTL: 30 წამი; რეალური expiry არ შეიძლება აღემატებოდეს parent session lease-ს (default 45 წამი).
- ახალი ticket-ის გაცემა იმავე allocation-ზე ძველ ticket-ს აუქმებს.
- Ticket მიბმულია კონკრეტულ serverId-ზე; სხვა shard-ზე claim უარყოფილია.
- პირველი claim ატომურად ცვლის session-ს allocated-იდან connected-ში.
- ერთი და იმავე claimAttemptId-ით retry idempotent-ია, რათა HTTP timeout-ის შემდეგ იგივე async claim-ის გამეორება შესაძლებელი იყოს.
- იგივე ticket სხვა claimAttemptId-ით იღებს JOIN_TICKET_ALREADY_USED-ს.
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

- PreLoginAsync first invokes Super::PreLoginAsync, preserving the engine's normal pre-login checks and event broadcast, then validates the ridgeJoinTicket connection option against the backend asynchronously.
- A successful server claim is held in a short-lived in-memory pending map (25 seconds).
- InitNewPlayer requires the same ticket to have a matching backend-verified claim; missing/expired claims are rejected.
- PostLogin sets the canonical backend identity on the server-only PlayerState field. Unexpected unverified connections are kicked through GameSession->KickPlayer.
- Logout releases the exact player/session pair through the Dedicated Server API.
- A 5-second cleanup timer releases verified claims that were never promoted to a controller; server shutdown reports the shard offline, which expires any remaining sessions.

RidgePublicId remains the replicated public game ID. The canonical account/player ID is stored in a private, non-replicated VerifiedPlayerId field and is only read by server-side backend calls.

The backend now separates the service roles:
- RIDGE_GATEWAY_TOKEN / x-ridge-gateway-token: session allocation and ticket issuance.
- RIDGE_SERVER_EVENT_TOKEN / x-ridge-server-token: shard registration/heartbeat, join-ticket claim and session release.

The gateway token must exist only in the gateway process. Dedicated Server processes must not receive it. The gateway service and external identity-provider integration are not implemented yet; current gateway endpoints are internal service-to-service primitives.

### Production transport caution

The bearer ticket is passed through Unreal's ridgeJoinTicket connection option and is short-lived (30 seconds). The application-side registry validation is single-use, but a production deployment must also verify encrypted/protected Unreal connection transport for the initial login options. HTTPS to the backend does not encrypt the separate UE game connection by itself.

### Current acceptance boundary

The C++ overrides and source-level contracts are committed and are being checked by static CI. This does not prove Unreal Engine 5.8 UBT/UHT compilation or a live network join. Still required: Windows UE 5.8 Editor/Server build, two-client PIE/Dedicated Server, rejection of a ticketless client, successful claim, public PlayerState replication, logout release, reconnect, and server shutdown recovery.


## 7. CI results — 2026-11-23

The latest committed revision is verified by two successful GitHub Actions workflows:

- Stage 5 Multiplayer Preflight: https://github.com/maisuradzee/Ridge/actions/runs/45131346534
- PostgreSQL 16 Integration: https://github.com/maisuradzee/Ridge/actions/runs/45131346543

| Gate | Result |
|---|---:|
| Python / BotLab / UE source regression | 66/66 PASS |
| Unreal project static validator | 24/24 PASS |
| UE UBT/UHT build | NOT RUN |
| Load-runner unit tests | 6/6 PASS |
| Backend Node regression | 37/37 PASS |
| PostgreSQL migrations 001–005 | PASS |
| PostgreSQL/live backend integration | 39 PASS / 0 FAIL / 0 SKIP |
| 500 virtual-client in-memory API preflight | 6,996 requests / 0 failures |

The 15-second development API preflight recorded 437.29 requests/second, p50 0.48 ms, p95 0.80 ms, p99 1.83 ms and max 7.23 ms; maximum observed simultaneous in-flight requests was 5. It uses in-memory development storage and is not a 500-player Unreal network test.

Machine-readable report: RIDGE_GIS/Data/QA/ridge_stage5_join_ticket_unreal_login_20261123.json.

The branch remains Draft. The results do not prove C++ compilation, UHT, PIE, a reachable Dedicated Server, encrypted game transport, account-provider integration, two-client replication, or 500 concurrent Unreal players.
