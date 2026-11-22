## 0. Static source/project validation (not a compile)

```powershell
python Tools\BotLab\validate_ue_project.py --project-root .
```

Expected current result: 24/24 PASS. This checks the UE 5.8 project descriptor, Build.cs dependencies, Game/Editor/Server targets and Bot QA Controller source wiring. It does **not** prove C++ compilation, UHT, PIE, NavMesh, physics or Dedicated Server operation.

# RIDGE BotLab — Unreal Engine 5.8 გაშვების checklist

ეს checklist საჭიროა V14-ის C++ adapter-ის რეალურ engine გარემოში დასადასტურებლად. მიმდინარე პაკეტში Unreal Build Tool არ არის, ამიტომ ქვემოთ ჩამოთვლილი ნაბიჯები ჯერ არ არის შესრულებულად მიჩნეული.

## 1. Editor/Server compile

PowerShell-ში მიუთითეთ UE 5.8-ის რეალური install folder:

```powershell
$env:RIDGE_UE_ROOT = 'D:\Epic Games\UE_5.8'
.\Tools\BotLab\Run-UE58BotLabBuild.ps1
.\Tools\BotLab\Run-UE58BotLabBuild.ps1 -BuildDedicatedServer
```

Script ამოწმებს engine `Build.version`-ს და compile-ს უშვებს `RIDGEEditor Win64 Development`-ზე; `-BuildDedicatedServer` დამატებით `RIDGEServer` target-ს აგებს. Compile failure ავტომატურად აბრუნებს non-zero exit-ს.

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