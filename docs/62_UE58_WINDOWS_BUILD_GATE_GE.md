# RIDGE — UE 5.8 Windows UBT/UHT build gate

მიზანი: RIDGE-ის რეალური C++ compile-ის გაშვება Unreal Engine 5.8-ზე.
Workflow: .github/workflows/ridge-ue58-windows-build.yml
Runner label: ridge-ue58
სტატუსი: workflow და runner ინსტრუქცია მზად არის; რეალური build ჯერ არ არის გაშვებული.

## 1. რატომ არის ცალკე Windows runner საჭირო

Stage 5-ის ჩვეულებრივი CI Linux runner-ზე ასრულებს Python/source/static/backend ტესტებს. ის არ შეიცავს RIDGE-ის UE 5.8 toolchain-ს და ამიტომ ვერ ადასტურებს C++ compilation-ს ან UHT-ს.

ეს workflow ხელით გაეშვება მხოლოდ Windows self-hosted runner-ზე, რომელსაც აქვს self-hosted, Windows, X64 და ridge-ue58 labels. ის არ რეაგირებს Pull Request-ზე და არ იყენებს production secrets-ს.

## 2. Runner-ის მომზადება

1. გახსენით კერძო RIDGE repository → Settings → Actions → Runners → New self-hosted runner.
2. აირჩიეთ Windows x64 და შეასრულეთ GitHub-ის მიერ ნაჩვენები download/configuration ბრძანებები build მანქანაზე.
3. Runner-ის რეგისტრაციისას დაამატეთ custom label: ridge-ue58.
4. იმავე მანქანაზე უნდა იყოს დაყენებული:
   - Unreal Engine 5.8 (RIDGE.uproject-ის შესაბამისი engine);
   - Visual Studio C++ x64 toolchain;
   - Unreal Engine 5.8-სთვის საჭირო Windows SDK/build prerequisites.
5. დაამატეთ machine-level environment variable:

       RIDGE_UE_ROOT=D:\Epic Games\UE_5.8

   გამოიყენეთ თქვენი რეალური install path და არა აუცილებლად ზემოთ მოყვანილი მაგალითი. თუ runner Windows service-ად მუშაობს, environment variable-ის შეცვლის შემდეგ restart გაუკეთეთ service-ს.
6. Runner შეზღუდეთ მხოლოდ RIDGE repository-ზე. არ გამოიყენოთ public repository-ებისთვის და არ დაამატოთ Production server/gateway/provisioning secrets.

## 3. Workflow-ის გაშვება

GitHub-ში:

- გახსენით Actions → RIDGE Unreal Engine 5.8 Windows Build;
- Branch აირჩიეთ codex/ridge-stage-5-multiplayer;
- build_dedicated_server=true დატოვეთ სრული build gate-ისთვის;
- დააჭირეთ Run workflow.

Workflow ჯერ ამოწმებს UE 5.8-ის ვერსიასა და Visual Studio C++ x64 toolchain-ს. შემდეგ იძახებს:

    .\Tools\BotLab\Run-UE58BotLabBuild.ps1 -UnrealRoot $env:RIDGE_UE_ROOT -BuildDedicatedServer

Build script ქმნის:
- RIDGE — Game executable/client target;
- RIDGEEditor — Editor/PIE target;
- RIDGEServer — Dedicated Server target, თუ ჩართულია checkbox/input.

## 4. შედეგის მიღება

წარმატებული შედეგის აუცილებელი პირობაა:
- ყველა არჩეული target: Status=PASS;
- საერთო ანგარიში: OverallStatus=PASS;
- UBT/UHT: UBTAndUHT=PASS.

Workflow ატვირთავს artifact-ს ridge-ue58-windows-build, რომელშიც იქნება:
- ridge_ue58_build_report.json;
- თითოეული target-ის .log ფაილი.

თუ runner არ არის online ან შესაბამისი label არ აქვს, workflow დარჩება queued მდგომარეობაში. ეს არ ნიშნავს compile success-ს. Linux static CI შედეგი ცალკე რჩება.

## 5. რას ადასტურებს ეს build და რას — არა

წარმატებული UBT/UHT ადასტურებს, რომ არჩეული RIDGE Game/Editor/Server C++ targets კომპილირდება კონკრეტულ UE 5.8 toolchain-ზე.

ის არ ადასტურებს:
- Editor-ში map-ის გახსნას და PIE-ს;
- Dedicated Server-ის რეალურ გაშვებას;
- OIDC provider-ის login/PKCE UI-ს;
- ClientTravel → PreLogin → PostLogin რეალურ network flow-ს;
- ორ მოთამაშეს შორის replication/reconnect-ს;
- game transport encryption-ს;
- 500 ერთდროულ Unreal client-ს.

ამ ეტაპებს ცალკე runtime test და telemetry სჭირდება.


## 6. Latest Linux CI evidence — 2026-11-24

The Windows workflow source and static contracts are covered by the latest Linux Stage 5 run, but that run does not perform the Unreal compile:

- [Stage 5 Multiplayer Preflight](https://github.com/maisuradzee/Ridge/actions/runs/45363645444): **SUCCESS** — 79/79 source tests, 37/37 static checks, load 6/6, backend 55 PASS / 0 FAIL / 2 SKIP.
- [PostgreSQL 16 Integration](https://github.com/maisuradzee/Ridge/actions/runs/45363645446): **SUCCESS** — migrations 001–006, 57 PASS / 0 FAIL / 0 SKIP.
- The UE project static report is uploaded as ridge-ue-project-static-validation (14-day retention).

Actual Windows UBT/UHT remains NOT_RUN until the manual workflow is dispatched on a registered ridge-ue58 runner.


## 7. Final PR-head CI result — 2026-11-24

On head 97d67d25064713c1654a60f8f2e7a82d7235cb0d:
- [Stage 5 source/static/API preflight](https://github.com/maisuradzee/Ridge/actions/runs/45364048038): **SUCCESS**, source 79/79, UE static 37/37, load unit 6/6, backend Node 55 PASS / 0 FAIL / 2 SKIP.
- [PostgreSQL 16 live integration](https://github.com/maisuradzee/Ridge/actions/runs/45364047739): **SUCCESS**, migrations 001–006, live suite 57 PASS / 0 FAIL / 0 SKIP.
- Static validator JSON is uploaded as ridge-ue-project-static-validation, with 14-day retention.

The manual Windows UE build workflow has not been dispatched; UBT/UHT remains NOT_RUN pending the ridge-ue58 runner.
