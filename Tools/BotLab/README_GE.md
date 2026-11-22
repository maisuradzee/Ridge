# RIDGE BotLab V14 — მოთამაშის ქცევის, ურთიერთქმედებისა და მოძრაობის QA

## დანიშნულება
BotLab არის სინთეზური QA სისტემა, რომელიც ამოწმებს RIDGE-ის მოქმედებების კატალოგს, თამაშის წესების წინაპირობებს, მდგომარეობის უსაფრთხო ცვლილებასა და Unreal-ის სატესტო მოძრაობის telemetry-ს. ეს არ არის მტკიცება, რომ სასრული სია აღწერს ყველა ადამიანს ან ყველა შესაძლო ქცევას. ყოველი ახალი gameplay სისტემა უნდა დაემატოს action intent-ით, ოპერაციული კონტრაქტით და შესაბამისი ტესტით.

## მოქმედებების კატალოგი
`action_catalog.json` შეიცავს **303 უნიკალურ action intent-ს 28 ოჯახში**. კატეგორიები მოიცავს გადაადგილებას/ნავიგაციას, რელიეფსა და გარემოს, ობიექტებს, ინვენტარს, ეკონომიკას, სოციალურ ქცევას, ჯანმრთელობასა და დახმარებას, სამუშაოსა და მისიებს, ტრანსპორტს, საკუთრებასა და კომუნალურ სერვისებს, ინფორმაციის მოძიებას, ჯგუფურ ქცევას, ხელმისაწვდომობას, ციფრულ სისტემებს, ყოველდღიურ რუტინას, განათლებას, სამოქალაქო/სამართლებრივ პროცედურებს და ცხოველთა მოვლას.

თითოეულ intent-ს აქვს წინაპირობების ტეგები, დაკვირვების ველები და retry პოლიტიკა. უარყოფილი მოქმედება თავისთავად შეცდომა არ არის; შეცდომაა არასწორი state mutation ან ინვარიანტის დარღვევა.

## სინთეზური გადაწყვეტილების მოდელი
16 გამოგონილი, არაკლინიკური აგენტის არქეტიპი ცვლის მხოლოდ QA გადაწყვეტილების ტენდენციებს: რისკისადმი დამოკიდებულებას, დაგეგმვის ჰორიზონტს, სოციალურ ორიენტაციას, სიახლის ძიებასა და ყურადღების სტაბილურობას. ეს არ არის რეალური ადამიანების დიაგნოზი ან ფსიქოლოგიური კლასიფიკაცია და არ უნდა გამოიყენებოდეს მოთამაშეების რეალურ ცხოვრებაში პროფილირებისთვის ან მანიპულაციისთვის.

## გარემოს ფაქტორები
20 გარემოს ღერძი მოიცავს ხილვადობას, ამინდს, ზედაპირს, ხალხის სიმჭიდროვეს, მარშრუტის მდგომარეობას, ინფორმაციის სიზუსტეს, მიზნის ვადას, სოციალურ კონტექსტს, რესურსებს, ობიექტის მდგომარეობას, ქსელს, მოწყობილობას/კონტროლს, სიმულირებულ ჯანმრთელობის მდგომარეობას, დროის წნეხს, სამყაროს დატვირთვას, ავტორიტეტის ხელმისაწვდომობას, პირადი სივრცის კონტექსტს, ურთიერთობის ტიპს, დავალების სირთულესა და წესების სიცხადეს.

მიმდინარე 20 ღერძზე **3,111 pairwise სცენარი** სრულდება. ეს ყველა ღერძის მნიშვნელობათა წყვილების დაფარვაა და არა სრული 20-განზომილებიანი Cartesian კომბინაციების ამოწურვა.

## სინთეზური ტრანზაქციული ურთიერთქმედების კონტრაქტები
`interaction_contracts.py` ქმნის იზოლირებულ სატესტო სამყაროს (არ უკავშირდება რეალურ მოთამაშის ანგარიშს ან production DB-ს). 18 action binding უკავშირდება 18 stateful ოპერაციას:

- კარის განბლოკვა/გაღება/დაკეტვა/ჩაკეტვა;
- საკუთრების განბლოკვა და შესვლა;
- ნივთის მოხმარება და გადაცემა;
- ვირტუალური ფულის გადარიცხვა და double-entry ledger;
- მისიის ჯილდოს ერთჯერადი მიღება;
- ავტომობილში ჩაჯდომა/გადმოსვლა და სავარძლების ორმხრივი შესაბამისობა;
- საზოგადოებრივ ტრანსპორტში ასვლა/ჩამოსვლა და ბილეთის/ტევადობის კონტროლი;
- დახმარება მხოლოდ თანხმობითა და დისტანციის პირობებში;
- კომუნალური სერვისის აღდგენა მხოლოდ უფლებამოსილი ტექნიკოსით;
- ცხოველის კვება მფლობელობისა და კეთილდღეობის შემოწმებით;
- crafting ოპერაცია რესურსის ატომური ჩამოჭრით.

ოპერაციები სინთეზურ state-ზე სრულდება. ჩავარდნისას state rollback ხდება. ერთი idempotency key + იგივე payload იწვევს cached replay-ს; იგივე key + განსხვავებული payload უარყოფილია. წარმატებული/უარყოფილი/replay მოთხოვნები აუდიტში ცალკე აღირიცხება.

**Stress შედეგი:** 1,200 შემთხვევითი ოპერაცია, 1,200 ინვარიანტის შემოწმება, 11 განზრახ ჩაშვებული შუა-ტრანზაქციული fault-ის rollback; საფულის საერთო ღირებულება შენარჩუნდა.

## გაშვება
პროექტის root-იდან:

```powershell
python Tools/BotLab/botlab.py --agents 64 --actions 250 --seed 20261121
python Tools/BotLab/interaction_contracts.py
python -m unittest discover -s Tools/BotLab/tests -p "test_*.py" -v
python Tools/BotLab/validate_ue_telemetry.py --project-root .
python Tools/Health/ridge_guardian.py --project-root . --quick
```

სრული test-suite-ისთვის:

```powershell
python -m unittest discover -s RIDGE_GIS/Tests -p "test_*.py" -v
python -m unittest discover -s Tools/Health/tests -p "test_*.py" -v
npm test --prefix backend
```

## Unreal Engine 5.8 movement adapter
`ARidgeBotTestController` არის server-authoritative QA controller და არა production NPC brain. მას შეუძლია waypoint route-ის მოთხოვნა/გაუქმება, request ID-ით ძველი completion callback-ის ფილტრაცია, stuck timeout-ის დაფიქსირება და JSONL telemetry-ის ჩაწერა.

ფაილი იქმნება უნიკალური controller session ID-ით:

`Saved/RIDGE/BotLab/movement_telemetry_<session-guid>.jsonl`

ჩანაწერები მოიცავს route/session ID-სა და generation-ს, server world time-ს, actor position/rotation/speed-ს, CharacterMovement mode-ს, ground/falling/crouching მდგომარეობას, Nav path status-სა და partial-path flag-ს, active waypoint-ს და collision impact point/normal-ს, სხვა actor-ის კლასს, collision channel-ს, physical material-სა და impulse magnitude-ს. მიუწვდომელი ველები ჩაიწერება `null`-ად და ჩამოითვლება `observability_missing_fields`-ში.

`validate_ue_telemetry.py` ამოწმებს JSONL schema-ს, session-ის ერთიანობას, route generation-ის მონოტონურობას, route lifecycle-ს, terminal მდგომარეობებს, movement sample-ის ველებსა და არასწორ finite/non-finite ფიზიკურ მნიშვნელობებს. Capture-ის შემდეგ ჩანაწერი აღარ უნდა გაგრძელდეს.

მოძრაობის მოთხოვნა იყენებს UE 5.8 `FAIMoveRequest` + `AAIController::MoveTo` API-ს, რადგან `MoveTo` აბრუნებს `FPathFollowingRequestResult`-ს `MoveId`-ით; ძველი callback ამ request ID-ით მოწმდება. ოფიციალური API:
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/AIModule/FAIMoveRequest?lang=en-US
- https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/AIModule/AAIController/MoveTo?application_version=5.8

**შეზღუდვა:** ამ runtime-ში Unreal Engine 5.8 Editor/Build Tool არ არის ხელმისაწვდომი; C++ compile/UHT, PIE, NavMesh bake, Dedicated Server და network replication ტესტები არ შესრულებულა. სანამ UE-ში არ გაეშვება, Guardian telemetry-ს `NOT_APPLICABLE`-ად ტოვებს.

## V14 ტესტირების დაფიქსირებული შედეგები
- BotLab unit tests: **28/28 PASS**.
- Interaction smoke contract checks: **35/35 PASS**.
- Interaction randomized stress: **1,200/1,200 invariant check**, 11 injected fault rollback.
- 303 action intent; 16 synthetic agents; 20 environmental axes; 3,111 pairwise scenario probes.
- 64 × 250 = 16,000 synthetic decisions; ბოლო გაშვებაზე 15,592 accepted / 408 rejected; invariant failures = 0.
- GIS regression: 10/10 PASS.
- Guardian unit tests: 12/12 PASS.
- Backend: 21 PASS / 0 FAIL / 1 SKIP (PostgreSQL integration-ს dedicated development DB სჭირდება).
- Blockout: PASS; Player Foundation: 10/10; Mission Bridge: 12/12.

## შეზღუდვები და უსაფრთხოების საზღვრები
- 14 მოქმედებას აქვს BotLab-ის მარტივი state-transition model; დანარჩენი 289 action intent ძირითადად contract/precondition probes-ია. 18 ტრანზაქციული ოპერაცია ცალკე სინთეზურ კონტრაქტულ მოდელშია განხორციელებული. ეს არ ნიშნავს, რომ ყველა gameplay სისტემა Unreal-ში უკვე იმპლემენტირებულია.
- რეალური Unreal physics/NavMesh/animation/collision/replication ჯერ არ დატესტილა.
- GIS tile manifest/production world package ჯერ არ არის ჩატვირთული.
- PostgreSQL integration ტესტი გამოტოვებულია dedicated development DB-ის არქონის გამო.
- 500 concurrent-player load/soak ტესტი ჯერ არ ჩატარებულა.
- ავტომატური აღდგენა არ ცვლის player money, inventory, property, ownership, rewards, database rows, credentials ან authored Unreal assets.
