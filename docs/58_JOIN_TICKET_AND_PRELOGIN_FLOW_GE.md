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

ამ ეტაპზე gateway და Dedicated Server ერთ shared internal token-ს იყენებენ. ეს მხოლოდ development/prototype control plane-ისთვისაა. Production-ში shared token უნდა ჩანაცვლდეს service-specific credentials-ით და HTTPS-ით.

მნიშვნელოვანი: RidgePublicId კვლავ prototype identifier-ია, სანამ verified account identity არ მიეწოდება gateway-ს. Join ticket არ ცვლის ანგარიშის ავტორიზაციას — ის მხოლოდ ერთჯერადი, მოკლევადიანი დაშვებაა კონკრეტულ Dedicated Server session-ზე.
