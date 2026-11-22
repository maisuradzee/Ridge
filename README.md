# RIDGE — Saburtalo Vertical Slice

RIDGE is an Unreal Engine 5.8 real-life open-world simulator prototype, with the first playable area planned around Saburtalo, Tbilisi.

## Current engineering snapshot — BotLab V14

Release status: **VERIFIED_WITH_LIMITATIONS**.

V14 adds 23 new or modified project files, including:

- 303 player/NPC action intents across 28 action families.
- 16 synthetic, non-clinical decision archetypes and 20 environmental axes.
- 16,000 simulated decisions (64 agents × 250 actions).
- 18 isolated stateful interaction-contract bindings covering access, ownership, inventory, wallet transfers, mission rewards, vehicles, public transport, consent, utilities, animal care, and crafting.
- Transactional rollback, double-entry ledger and wallet-conservation checks, idempotency replay checks, and audit events.
- Unreal-side Bot QA controller and telemetry validation for navigation/movement/collision sessions.
- Guardian integration, test suites, reports, and an Unreal Engine 5.8 integration checklist.

## Run the Python QA suites

From the repository root:

```powershell
python -m compileall -q Tools/BotLab Tools/Health
python -m unittest discover -s Tools/BotLab/tests -p "test_*.py" -v
python Tools/BotLab/botlab.py --agents 64 --actions 250 --seed 20261121
python Tools/Health/ridge_guardian.py --project-root . --quick
```

For real Unreal Engine 5.8 validation, see [Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md](Tools/BotLab/UE58_INTEGRATION_CHECKLIST_GE.md) and run [Tools/BotLab/Run-UE58BotLabBuild.ps1](Tools/BotLab/Run-UE58BotLabBuild.ps1) on a machine with the matching UE 5.8 toolchain installed.

## Important validation boundaries

The Python tests validate the synthetic simulation and isolated interaction contracts. They do **not** prove that every gameplay feature is already implemented in Unreal.

The following remain unverified in this environment:

- Unreal C++ compilation/UHT, PIE, NavMesh baking, Dedicated Server, collision/physics behavior, and network replication.
- A completed live Unreal BotLab telemetry session.
- Production GIS tile ingestion and World Generator execution.
- PostgreSQL integration (the database integration test is skipped without an isolated development database).
- 500-concurrent-player load/soak testing.

The current release therefore remains **VERIFIED_WITH_LIMITATIONS**, not production-ready. Guardian must not silently mutate player wallets/ledger, inventory, property, ownership, rewards, production databases, credentials, authored Unreal assets, or project settings.

## Key V14 files

- [V14 test report](HEALTH_AUTOMATION_V14_STATUS_GE.md)
- [Release manifest](V14_BOTLAB_RELEASE_MANIFEST.json)
- [BotLab action catalog](Tools/BotLab/action_catalog.json)
- [Transactional interaction contracts](Tools/BotLab/interaction_contracts.py)
- [UE movement telemetry validator](Tools/BotLab/validate_ue_telemetry.py)
- [Interaction contract test suite](Tools/BotLab/tests/test_interaction_contracts.py)
- [QA reports](RIDGE_GIS/Data/QA/)


## V14 follow-up — UE source wiring

The BotLab V14 branch now includes the UE 5.8 project descriptor, Game/Editor/Server target definitions, module dependencies, a 24/24 source-wiring validator, two regression tests and a focused GitHub Actions workflow. This remains static verification only: the actual Unreal toolchain and PIE runtime are not available in this validation environment.

See `RIDGE_STAGE_2_4_EXECUTION_REPORT_GE.md` for the 2–4 stage report.


## Stage 2–4 CI verification

All three configured GitHub Actions workflows completed successfully on the current BotLab V14 branch. The ephemeral PostgreSQL 16 job applied migrations 001–003 and passed **23/23** backend/PostgreSQL integration tests. This was an isolated CI database, not a production or user database. Unreal Engine 5.8 compilation/UHT/PIE/NavMesh and runtime movement tests remain pending; stage 5 multiplayer/load testing is intentionally deferred.
