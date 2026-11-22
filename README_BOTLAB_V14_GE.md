# RIDGE BotLab V14

V14 ამატებს სინთეზურ მოქმედებების ტესტირებას, transactional interaction contracts-სა და Unreal Engine 5.8 movement telemetry validator-ს.

- 303 action intent / 28 family
- 16 სინთეზური, არაკლინიკური გადაწყვეტილების არქეტიპი
- 20 გარემოს ღერძი / 3,111 pairwise probe
- 64 აგენტი × 250 გადაწყვეტილება = 16,000 synthetic events
- 18 ტრანზაქციული interaction contract binding
- 35/35 contract smoke checks
- 1,200 randomized fault-injection operations / 1,200 invariant checks
- 28/28 BotLab unit tests

დეტალური ინსტრუქცია: `Tools/BotLab/README_GE.md`  
სტატუსი და ტესტების ანგარიში: `HEALTH_AUTOMATION_V14_STATUS_GE.md`  
Guardian ანგარიში: `RIDGE_GIS/Data/QA/ridge_health_report_v14.json`

გაშვება:

```powershell
python Tools/BotLab/botlab.py --agents 64 --actions 250 --seed 20261121
python Tools/BotLab/interaction_contracts.py
python -m unittest discover -s Tools/BotLab/tests -p "test_*.py" -v
python Tools/Health/ridge_guardian.py --project-root . --quick
```

**Release status: `VERIFIED_WITH_LIMITATIONS`.** Unreal Engine 5.8 compile/UHT/PIE/NavMesh/Dedicated Server/replication ტესტები რეალურ UE გარემოში ჯერ არ ჩატარებულა; telemetry validator შესაბამისად `NOT_APPLICABLE`-ს აბრუნებს, სანამ UE session log არ შეიქმნება.

PostgreSQL-ის რეალური, იზოლირებული QA ტესტისთვის (Windows + Docker Desktop + Node.js 22):

```powershell
.\Tools\Database\Run-PostgresIntegration.ps1
```

ეს ქმნის დროებით PostgreSQL 16 კონტეინერს, იყენებს migrations 001–003-ს, ამოწმებს restart persistence-ს და ბოლოს შლის კონტეინერს. Production/Supabase მონაცემებს არ ეხება.

Unreal Engine 5.8 project/source wiring-ის სტატიკური შემოწმება (ეს compile/UHT/PIE ტესტს არ ცვლის):

```powershell
python Tools/BotLab/validate_ue_project.py --project-root .
```

მოსალოდნელი სტატიკური შედეგი: `24/24 STATIC PASS`; რეალური UE build/runtime სტატუსი ცალკე უნდა დადასტურდეს.

## Multi-seed regression

Four deterministic seeds completed: **64,000 synthetic events / 0 invariant failures**. See `RIDGE_GIS/Data/QA/ridge_botlab_seed_matrix_v14.json`.
