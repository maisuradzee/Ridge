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
