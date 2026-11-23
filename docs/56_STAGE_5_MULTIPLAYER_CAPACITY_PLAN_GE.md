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
