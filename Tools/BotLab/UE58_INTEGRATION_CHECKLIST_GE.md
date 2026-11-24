## 0. Static source/project validation (not a compile)

```powershell
python Tools\BotLab\validate_ue_project.py --project-root .
```

Expected current result: 37/37 STATIC_PASS on the latest Stage 5 branch snapshot. This remains source/project validation only; UBT/UHT are not executed here. This checks the UE 5.8 project descriptor, Build.cs dependencies, Game/Editor/Server targets and Bot QA Controller source wiring. It does **not** prove C++ compilation, UHT, PIE, NavMesh, physics or Dedicated Server operation.

# RIDGE BotLab — Unreal Engine 5.8 გაშვების checklist

ეს checklist საჭიროა V14-ის C++ adapter-ის რეალურ engine გარემოში დასადასტურებლად. მიმდინარე პაკეტში Unreal Build Tool არ არის, ამიტომ ქვემოთ ჩამოთვლილი ნაბიჯები ჯერ არ არის შესრულებულად მიჩნეული.

## 1. Editor/Server compile

PowerShell-ში მიუთითეთ UE 5.8-ის რეალური install folder:

```powershell
$env:RIDGE_UE_ROOT = 'D:\Epic Games\UE_5.8'

# Default: main Game executable + Editor/PIE target
.\Tools\BotLab\Run-UE58BotLabBuild.ps1

# Full local compile gate: Game + Editor/PIE + Dedicated Server
.\Tools\BotLab\Run-UE58BotLabBuild.ps1 -BuildDedicatedServer
```

Script ამოწმებს engine `Build.version`-ს და ზუსტად UE 5.8-ს. Default-ად აგებს `RIDGE Win64 Development` (main game executable) და `RIDGEEditor Win64 Development` target-ებს; `-BuildDedicatedServer` დამატებით `RIDGEServer` target-ს აგებს. თითოეული target-ის ლოგი და ერთიანი JSON ანგარიში ინახება `RIDGE_GIS/Data/QA`-ში. Build failure report-ში ფიქსირდება და script non-zero exit-ით სრულდება. Unreal Build Tool-ის გამოძახება UHT-საც უშვებს შესაბამისი target-ის compile pipeline-ში.

## 2. Test map და NavMesh

1. გახსენით `RIDGE.uproject` Unreal Engine 5.8 Editor-ში.
2. შექმენით ცალკე QA map; არ გამოიყენოთ production/save world-ის სატესტო მდგომარეობის შესაცვლელად.
3. მოათავსეთ `NavMeshBoundsVolume`, რომელიც ფარავს სატესტო ბლოკს; დააჭირეთ `P` და გადაამოწმეთ navigable ზედაპირი.
4. გამოიყენეთ სატესტო `ACharacter` pawn, რომელსაც აქვს Capsule Collision და `CharacterMovementComponent`.
5. Pawn-ის AI Controller Class მიუთითეთ `RidgeBotTestController`-ზე და Auto Possess AI ჩართეთ სატესტო რუკაში.
6. level/test Blueprint-იდან გამოიძახეთ `StartWaypointRoute`-ით 2–5 waypoint. ცალკე სცენარებად გაუშვით ღია მარშრუტი, კედლით დაბლოკილი მიზანი, უკვე მიღწეული waypoint, route cancel, ახალი route-ით ძველის ჩანაცვლება და ხელოვნური ჩაჭედვა.
7. სატესტოს დასასრულს გამოიძახეთ `FinalizeTelemetryCapture` ან გააჩერეთ controller ისე, რომ `EndPlay`-მა capture დახუროს.

## 3. Telemetry და Guardian

```powershell
python Tools\BotLab\validate_ue_telemetry.py --project-root .
python Tools\Health\ridge_guardian.py --project-root . --quick
```

მოსალოდნელი შედეგი რეალური UE session-ის შემდეგ: telemetry validator `PASS`; Guardian აღარ უნდა აბრუნებდეს `ue_movement_telemetry: NOT_APPLICABLE`. თუ log შეიცავს არასწორ route lifecycle-ს, NaN/Infinity-ს ან დაუსრულებელ route-ს, validator `FAIL`-ს დააბრუნებს.

## 4. მინიმალური მიღების კრიტერიუმები

- Editor target და Dedicated Server target build წარმატებულია.
- `controller_ready` პირველია და `capture_finalized` ზუსტად ერთხელ, ბოლო ჩანაწერია.
- ყველა `route_started`-ს ზუსტად ერთი terminal შედეგი აქვს: `completed`, `cancelled` ან `failed`.
- ძველი route-ის callback ახალ route-ს არ ცვლის.
- დაბლოკილი მიზანი partial route-ად არ ითვლება წარმატებულად.
- movement sample-ში არ არის NaN/Infinity ან უარყოფითი სიჩქარე.
- collision-ის არმქონე ველები null-ად/observability gap-ად არის მონიშნული, არ არის გაყალბებული ნულით.
- PIE და Dedicated Server-ზე ცალ-ცალკე გაიარა მინიმუმ თითო route.

**შენიშვნა:** ეს QA harness არ ცვლის production NPC AI-ს და არც მტკიცებულებაა, რომ სრული თამაშის მოძრაობის ყველა მექანიკა უკვე იმპლემენტირებულია.

## 5. New login subsystem and build-runner static verification — 2026-11-23

The project validator now includes the client login subsystem:
- UHT generated header is checked as the final include;
- BlueprintCallable entry point and BlueprintAssignable result event are required;
- gateway Bearer request, ticket/attempt UUID and expiry validation, ClientTravel, exact loopback HTTP allowlist and absence of internal service credentials are checked;
- Http module dependency and the non-secret development Gateway URL are required.

CI on commit `55b2f1ccfe59cd3d97be1d941efc53d942406c77` reports **37/37 STATIC_PASS** and **77/77** source/regression checks PASS. It does not execute UBT/UHT. Run the PowerShell build script on the UE 5.8 workstation to produce the first real compile report.


## 6. Automated Windows UE 5.8 build workflow

A separate manual workflow exists at .github/workflows/ridge-ue58-windows-build.yml. It is intentionally restricted to a dedicated self-hosted Windows runner with the custom label ridge-ue58; the normal Linux Stage 5 CI never claims to be a real Unreal compile.

### Runner setup

1. In the private RIDGE repository, open Settings → Actions → Runners → New self-hosted runner and choose Windows x64.
2. Follow GitHub's generated download/configuration commands on the Windows build machine. Add the custom label ridge-ue58 while configuring the runner.
3. Install Unreal Engine 5.8, Visual Studio C++ x64 build tools and the Windows SDK required by that UE installation.
4. Set the machine-level environment variable RIDGE_UE_ROOT to the UE 5.8 installation folder, for example D:Epic GamesUE_5.8. Restart the runner service after changing the environment.
5. Keep this runner restricted to the RIDGE repository. Do not register it for public repositories and do not add production game/API secrets to its environment.

### Run the real build

1. Open Actions → RIDGE Unreal Engine 5.8 Windows Build.
2. Select branch codex/ridge-stage-5-multiplayer and press Run workflow.
3. Keep build_dedicated_server=true for the complete Game + Editor + Dedicated Server gate.

The workflow checks the UE version and Visual Studio C++ toolchain, then runs Run-UE58BotLabBuild.ps1. A successful report must show all requested targets as PASS and UBTAndUHT=PASS. The workflow uploads ridge_ue58_build_report.json and one log per target as the ridge-ue58-windows-build artifact.

If the runner is not registered/online, the workflow stays queued; a Linux static PASS is not a substitute for this build. The build does not require or use RIDGE_SERVER_EVENT_TOKEN, gateway credentials or production secrets.

### What a successful build proves

A successful UBT/UHT build proves the Game, Editor and selected Server targets compile against the installed UE 5.8 toolchain. It still does not prove PIE, network reachability, the login provider flow, two-player replication, encryption or 500 connected players. Those are separate runtime acceptance tests.


## 7. Latest Linux CI and Windows compile gate state — 2026-11-24

Branch snapshot 7e1156c4ff462387165a2548afc55dabffecf402 passed:
- Python/BotLab/Unreal source regression: 79/79 PASS;
- UE project static validation: 37/37 STATIC_PASS;
- load runner: 6/6 PASS;
- backend Node: 55 PASS / 0 FAIL / 2 SKIP;
- PostgreSQL 16 migrations 001–006/live backend: 57 PASS / 0 FAIL / 0 SKIP;
- 500 virtual HTTP users: 6,996 requests / 0 failures / 437.31 req/s.

The static validator JSON is uploaded as artifact ridge-ue-project-static-validation for 14 days. Real UBT/UHT is not yet run. The manual Windows workflow is committed and documented in docs/62_UE58_WINDOWS_BUILD_GATE_GE.md; it requires the ridge-ue58 self-hosted runner.
