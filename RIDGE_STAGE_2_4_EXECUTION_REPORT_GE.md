# RIDGE — ეტაპები 2–4 შესრულების ანგარიში

**თარიღი:** 2026-11-22  
**საბაზისო პროექტი:** RIDGE Saburtalo Vertical Slice v0.6.0  
**BotLab:** V14.2 hardening  
**საერთო სტატუსი:** `VERIFIED_WITH_LIMITATIONS`

## ეტაპი 2 — Unreal Engine 5.8 ინტეგრაცია

- Bot QA Controller-ის source contract შემოწმებულია: server authority, waypoint route, partial-path rejection, stale request ID filtering, stuck timeout, movement/collision telemetry და capture finalization.
- დაემატა `validate_ue_project.py`: **24/24 STATIC PASS**.
- დაემატა project wiring-ის 2 regression test და დამატებითი 8 source-contract test.
- `.uproject`, Runtime/Editor/Server targets, `RIDGE.Build.cs`, source files და `Config` GitHub branch-შია.
- **ჯერ არ შესრულებულა:** Unreal C++ compile/UHT, PIE, NavMesh bake, რეალური route/collision/physics და Dedicated Server runtime. ამ execution environment-ში Unreal Engine 5.8 toolchain არ არის ხელმისაწვდომი.

## ეტაპი 3 — მოთამაშის/NPC გადაწყვეტილებების ტესტირება

- 303 action intents / 28 ოჯახი; 16 სინთეზური, არაკლინიკური გადაწყვეტილების არქეტიპი.
- 20 გარემოს ღერძი; 3,111 pairwise probe.
- ორი დამოუკიდებელი 16,000-event simulation:
  - seed `20261121`: 15,592 accepted / 408 rejected / 0 invariant failures.
  - seed `20261122`: 15,549 accepted / 451 rejected / 0 invariant failures.
- BotLab, interaction, telemetry, UE project integration და UE source contract Python suite: **42/42 PASS**.
- Interaction contracts: **35/35 PASS**; randomized stress: 1,200 ოპერაცია / 1,200 invariant checks; 11 injected-fault rollback.
- უარყოფილი მოქმედებები თამაშის წინაპირობების დარღვევას/შეუსრულებელ მოთხოვნას აღნიშნავს და არა invariant failure-ს.
- ეს ტესტები ფარავს მოდელირებულ მოქმედებებსა და pairwise სცენარებს; ყველა ადამიანის შესაძლო ქცევის ამომწურავ მტკიცებად არ ითვლება.

## ეტაპი 4 — Backend და მონაცემთა ბაზა

- Backend Node suite: **22 PASS / 0 FAIL / 1 SKIP**.
- PostgreSQL repository contract tests: **7/7 PASS**.
- Checkpoint event ID-ის check-then-insert race დაცულია transaction-scoped advisory lock-ით (`pg_advisory_xact_lock(hashtextextended(...))`).
- Event ID replay მიიღება მხოლოდ მაშინ, როცა job, checkpoint და server-observed position ემთხვევა თავდაპირველ payload-ს; განსხვავებული payload აბრუნებს `SERVER_EVENT_REUSED`.
- Integration test მოიცავს checkpoint order/radius, exact replay, conflicting payload, parallel cross-job event ID reuse, parallel one-time reward, balanced ledger და restart persistence სცენარებს.
- დაემატა `Tools/Database/Run-PostgresIntegration.ps1`, რომელიც დროებით PostgreSQL 16 Docker QA გარემოს ქმნის, migrations 001–003-ს იყენებს და ტესტის შემდეგ კონტეინერს შლის.
- **ჯერ არ შესრულებულა:** რეალურ development PostgreSQL-ზე migrations და live integration. ამ runtime-ში Docker/PostgreSQL server/psql არ არის; integration test განზრახ დარჩა SKIP.

## GitHub CI

- `.github/workflows/ridge-botlab-v14.yml` ამოწმებს Python/BotLab, UE project static validation, transactional contracts, telemetry schema და Node backend.
- GitHub Actions-ის ბოლო workflow run-ები დასრულდა `success`-ით.
- PR #2 Draft რჩება; `main` არ არის გაერთიანებული.

## ეტაპი 5 — ცალკე, ერთობლივი ეტაპი

Multiplayer, replication, Dedicated Server ქსელური სცენარები და 500 მოთამაშის load/soak ტესტები მომხმარებლის მითითებით გადადებულია ერთობლივ ეტაპზე.

Production wallet/ledger, inventory, property, ownership, rewards, production DB, credentials და authored Unreal assets ტესტებისას ავტომატურად არ შეცვლილა.