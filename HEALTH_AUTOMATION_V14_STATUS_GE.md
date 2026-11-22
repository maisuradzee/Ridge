# RIDGE Health Automation & BotLab V14 — ტესტირების ანგარიში

**პროექტი:** RIDGE Saburtalo Vertical Slice v0.6.0  
**Engine target:** Unreal Engine 5.8  
**Release status:** `VERIFIED_WITH_LIMITATIONS`  
**ანგარიშის თარიღი:** 2026-11-22

## 1. V14 ცვლილებები

- BotLab-ის მოქმედებების კატალოგი: 303 action intent / 28 ოჯახი.
- სინთეზური გადაწყვეტილების აგენტები: 16 არაკლინიკური არქეტიპი.
- გარემოს მოდელი: 20 ღერძი; 3,111 pairwise probe/სცენარი.
- სრული სინთეზური გაშვება: 64 აგენტი × 250 მოქმედება = 16,000 მოვლენა.
- 18 stateful interaction contract binding: კარი, საკუთრება, ინვენტარი, ვირტუალური ფული, მისიის ჯილდო, მანქანის სავარძლები, საზოგადოებრივი ტრანსპორტი, თანხმობა, utility, ცხოველის მოვლა და crafting.
- transactional rollback, double-entry ledger, wallet conservation, item/vehicle/transport invariants.
- idempotency: ერთნაირი მოთხოვნის replay არ იმეორებს state mutation-ს; იგივე გასაღებით განსხვავებული payload უარყოფილია; replay მცდელობა audit-ში ცალკე ჩანს.
- UE 5.8 test controller: finite waypoint validation, loop-based already-at-goal handling, request ID filtering, route generation, collision/movement telemetry.
- Telemetry validator: session consistency, route generation order, route terminal lifecycle, finalized capture, finite physics value checks.
- PowerShell UE 5.8 Editor/Server build helper და რეალური UE QA integration checklist.

## 2. შესრულებული ტესტების ზუსტი შედეგები

| შემოწმება | შედეგი |
|---|---:|
| Python compileall (BotLab/Health/GIS tools) | PASS |
| BotLab unit tests | 28/28 PASS |
| Interaction contract smoke suite | 35/35 PASS |
| Randomized interaction stress | 1,200 ოპერაცია / 1,200 invariant checks |
| Fault injection rollback | 11/11 ჩაშვებული fault უსაფრთხოდ rollback |
| Action-contract bindings | 18/18 mapped; missing = 0 |
| Full BotLab simulation | 16,000 events; 15,592 accepted / 408 rejected |
| Catalog isolation sweep | 303/303 intents probed |
| Pairwise environment sweep | 3,111/3,111; invariant failures = 0 |
| GIS regression tests | 10/10 PASS |
| Guardian unit tests | 12/12 PASS |
| Backend tests | 21 PASS / 0 FAIL / 1 SKIP |
| Blockout validator | PASS |
| Player Foundation static checks | 10/10 PASS |
| Mission Bridge static checks | 12/12 PASS |
| Guardian quick check | 9 PASS / 0 FAIL / 3 limitations |
| UE telemetry validator | `NOT_APPLICABLE`, 0 session files found |

უარყოფილი მოქმედებები (408) არის თამაშის წესებით უარყოფილი/წინაპირობადაკარგული მცდელობები; ისინი invariant failure არ არის. სინთეზურ BotLab run-ში invariant failure = 0.

Interaction stress შედეგი: seed 140022; 399 accepted, 801 rejected; 11 injected fault rollback; wallet value conserved; 154 ledger rows; 1,200 audit events. ერთსა და იმავე idempotency key-ზე 40 პარალელური მოთხოვნის ტესტში მხოლოდ ერთი ასრულებს ფულის ცვლილებას, 39 კი replay-ად ბრუნდება; 12 სხვადასხვა გადარიცხვის parallel test-მა არ დაუშვა overdraw/ledger imbalance.

## 3. Guardian-ის ბოლო ანგარიში

ფაილი: `RIDGE_GIS/Data/QA/ridge_health_report_v14.json`  
სტატუსი: `VERIFIED_WITH_LIMITATIONS`  
შემოწმებები: 12; PASS: 9; FAIL: 0; limitations: 3.

Limitations:
1. Unreal Engine 5.8 Build Tool/Editor ამ execution environment-ში არ არის (SKIPPED).
2. Unreal movement telemetry session log ჯერ არ არსებობს (NOT_APPLICABLE).
3. GIS `tile_manifest.json`/World Generator-ის production source package ჯერ არ არსებობს (NOT_APPLICABLE).

**სრული Guardian aggregate ბრძანება ამ გარემოში execution timeout-ს გასცდა.** ეს არ ჩაითვალა წარმატებულად. მისი ქვეკომპონენტები ცალკე გაეშვა და ზემოთ ჩამოთვლილი ტესტები ინდივიდუალურად PASS იყო; quick Guardian run-იც დასრულდა.

## 4. რას არ ადასტურებს ეს ანგარიში

- Unreal C++ compilation/UHT/PIE არ ჩატარებულა.
- NavMesh bake, რეალური bot route, collision, physics, animation და replication არ დატესტილა.
- Dedicated Server executable არ არის აგებული/გაშვებული.
- PostgreSQL integration test გამოტოვებულია: საჭიროა ცალკე, იზოლირებული development database და `RIDGE_RUN_POSTGRES_INTEGRATION=YES`.
- 500 concurrent player load/soak test არ ჩატარებულა.
- World Generator რეალური GIS source tiles-ით არ გაშვებულა.
- 303 action intent-იდან 14-ს აქვს მარტივი BotLab state-transition model, 289 არის contract/precondition probe; 18 interaction contract ცალკე სინთეზურ transactional model-შია. ეს არ ნიშნავს, რომ ყველა gameplay მექანიკა უკვე Unreal-ში მზადაა.

## 5. უსაფრთხო აღდგენის საზღვრები

Guardian არ ცვლის player wallet/ledger-ს, inventory-ს, property-ს, ownership-ს, reward-ს, production DB-ს, credentials-ს, authored Unreal asset-ებს ან project settings-ს. ავტომატური აღდგენა შემოიფარგლება allow-list-ით ნებადართულ disposable/derived output-ებზე. ფინანსური შეცდომის შესწორება საჭიროებს აუდიტირებად reversal/compensating transaction-ს და არა ჩუმ row overwrite-ს.

## 6. UE 5.8 შემდეგი ნაბიჯი

1. `Tools/BotLab/Run-UE58BotLabBuild.ps1`-ით ააგეთ Editor target; სურვილისამებრ `-BuildDedicatedServer`.
2. გახსენით QA map, bake NavMesh და გაუშვით `ARidgeBotTestController`-ით route/cancel/stuck/obstacle სცენარები.
3. შექმენით `Saved/RIDGE/BotLab/movement_telemetry_<session-guid>.jsonl` session.
4. გაუშვით `python Tools/BotLab/validate_ue_telemetry.py --project-root .`.
5. მხოლოდ PASS telemetry და Editor/Server build-ის შემდეგ შეიძლება UE movement subsystem-ის შემდეგი release gate ჩაითვალოს გავლილად.

დეტალური checklist: `Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md`.


## 7. დამატებითი აუდიტი და V14 hardening (2026-11-22)

სრული v0.6.0 + BotLab V14 პაკეტი ცალკე ამოარქივდა და შემოწმდა; ZIP integrity check წარმატებით დასრულდა. ეს აუდიტი GitHub-ის მხოლოდ BotLab overlay ფაილებზე არ შემოიფარგლა.

### დამატებითი აღმოჩენა და გამოსწორება

- `vehicle.exit` ახლა მოითხოვს, რომ მოთხოვნაში მითითებული მანქანა ემთხვეოდეს მოთამაშის რეალურ მიმდინარე მანქანას.
- `transport.exit` ახლა მოითხოვს, რომ მითითებული ტრანსპორტი ემთხვეოდეს მოთამაშის მიმდინარე ტრანსპორტს.
- მოთამაშე ვერ ჩაჯდება მანქანაში და საზოგადოებრივ ტრანსპორტში ერთდროულად.
- inventory-ის არმქონე actor იღებს მკაფიო domain rejection-ს და არა შიდა `KeyError`-ს inventory transfer/crafting ოპერაციებში.
- დაემატა 4 regression test ზემოაღნიშნული შემთხვევებისთვის, 8 Unreal source contract static test და 2 project integration test. დაემატა 24-პუნქტიანი UE project static validator.

### ახლად შესრულებული ტესტები

| შემოწმება | შედეგი |
|---|---:|
| BotLab + interaction + telemetry unit tests | 32/32 PASS |
| Unreal source contract static tests | 8/8 PASS |
| გაერთიანებული BotLab Python suite | 42/42 PASS |
| GIS regression | 10/10 PASS |
| Guardian unit tests | 12/12 PASS |
| Backend Node tests | 22 PASS / 0 FAIL / 1 SKIP |
| BotLab 16,000-event simulation | 16,000; invariant failures = 0 |
| Interaction contract smoke | 35/35 PASS |
| Randomized contract stress | 1,200/1,200 invariant checks; 11 fault rollbacks |
| Player Foundation / Mission Bridge | 10/10 და 12/12 PASS |
| Blockout validator | PASS |

### ინტეგრაციისთვის დამატებული ხელსაწყოები

- `.github/workflows/ridge-botlab-validation.yml` — Python BotLab/source-contract და Node backend CI.
- `Tools/Database/Run-PostgresIntegration.ps1` — დროებითი PostgreSQL 16 QA კონტეინერი, migrations 001–003 და restart-persistence integration test.
- `database/POSTGRES_QA_RUNBOOK_GE.md` — უსაფრთხო გაშვების ინსტრუქცია.

### დარჩენილი გარე შესრულების ბარიერები

ამ execution environment-ში Docker, PostgreSQL CLI და Unreal Engine 5.8 toolchain არ არის ხელმისაწვდომი. ამიტომ PostgreSQL migrations/restart test და Unreal UHT/C++ build/PIE/NavMesh/Server ტესტები რეალურად არ გაშვებულა. PostgreSQL checkpoint event ID race კი transaction-scoped advisory lock-ით არის დაცული და payload-bound replay regression test-ით შემოწმებული. ახალი PowerShell runner მომზადებულია RIDGE-ის Windows/Docker გარემოში გასაშვებად. ეს ტესტები PASS-ად არ ითვლება, სანამ შესაბამისი runtime შედეგი არ დაბრუნდება.


## 8. PostgreSQL event-ID race hardening

`recordJobCheckpoint` transaction-ში event ID-ზე იღებს `pg_advisory_xact_lock(hashtextextended(...))` lock-ს, შემდეგ ამოწმებს უკვე ჩაწერილ event-ს. Replay დასაშვებია მხოლოდ მაშინ, თუ job ID, checkpoint key და observed position ემთხვევა. სხვა payload იღებს `SERVER_EVENT_REUSED` პასუხს. Repository contract suite: 7/7 PASS; live PostgreSQL integration ჯერ SKIP-ია.