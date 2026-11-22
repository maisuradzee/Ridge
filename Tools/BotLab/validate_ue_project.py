#!/usr/bin/env python3
"""Static integration checks for the RIDGE Unreal Engine 5.8 BotLab adapter.

This verifies project/source wiring only. It does NOT compile C++, run UHT,
bake NavMesh, launch PIE, or test a Dedicated Server.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from typing import Any

REQUIRED_MODULES = {"Core", "CoreUObject", "Engine", "AIModule", "NavigationSystem", "Json", "JsonUtilities"}


def validate_project(root: Path) -> dict[str, Any]:
    root = root.resolve()
    checks: list[dict[str, Any]] = []

    def add(check_id: str, passed: bool, detail: str) -> None:
        checks.append({"id": check_id, "status": "PASS" if passed else "FAIL", "detail": detail})

    project_path = root / "RIDGE.uproject"
    module_path = root / "Source" / "RIDGE" / "RIDGE.Build.cs"
    target_paths = [root / "Source" / name for name in ("RIDGE.Target.cs", "RIDGEEditor.Target.cs", "RIDGEServer.Target.cs")]
    header_path = root / "Source" / "RIDGE" / "Public" / "RidgeBotTestController.h"
    cpp_path = root / "Source" / "RIDGE" / "Private" / "RidgeBotTestController.cpp"

    add("uproject_exists", project_path.is_file(), str(project_path.relative_to(root)))
    project: dict[str, Any] = {}
    if project_path.is_file():
        try:
            project = json.loads(project_path.read_text(encoding="utf-8"))
            add("uproject_json_valid", True, "RIDGE.uproject parses as JSON")
        except (OSError, json.JSONDecodeError) as exc:
            add("uproject_json_valid", False, str(exc))
    else:
        add("uproject_json_valid", False, "Project descriptor is missing")
    add("engine_association_58", project.get("EngineAssociation") == "5.8", f"EngineAssociation={project.get('EngineAssociation')!r}")
    modules = project.get("Modules", [])
    add("runtime_module_registered", any(m.get("Name") == "RIDGE" and m.get("Type") == "Runtime" for m in modules if isinstance(m, dict)), "RIDGE Runtime module registration")

    add("module_build_cs_exists", module_path.is_file(), "Source/RIDGE/RIDGE.Build.cs")
    build_cs = module_path.read_text(encoding="utf-8") if module_path.is_file() else ""
    missing_modules = sorted(module for module in REQUIRED_MODULES if f'"{module}"' not in build_cs)
    add("required_engine_modules", not missing_modules, "all required modules present" if not missing_modules else "missing: " + ", ".join(missing_modules))

    missing_targets = [str(path.relative_to(root)) for path in target_paths if not path.is_file()]
    add("all_targets_exist", not missing_targets, "Game, Editor and Server targets exist" if not missing_targets else "missing: " + ", ".join(missing_targets))

    add("controller_header_exists", header_path.is_file(), "RidgeBotTestController.h")
    header = header_path.read_text(encoding="utf-8") if header_path.is_file() else ""
    generated = '#include "RidgeBotTestController.generated.h"'
    includes = [line.strip() for line in header.splitlines() if line.strip().startswith("#include")]
    add("uht_generated_include_last", bool(includes) and includes[-1] == generated, "generated.h is the final include")
    for symbol in ("UCLASS(Blueprintable)", "class RIDGE_API ARidgeBotTestController", "StartWaypointRoute", "CancelTestRoute", "FinalizeTelemetryCapture", "OnMoveCompleted"):
        add("header_declares_" + symbol.split("(")[0].replace(" ", "_").replace("::", "_"), symbol in header, symbol)

    add("controller_cpp_exists", cpp_path.is_file(), "RidgeBotTestController.cpp")
    cpp = cpp_path.read_text(encoding="utf-8") if cpp_path.is_file() else ""
    source_requirements = {
        "authority_guard": "HasAuthority()" in cpp,
        "path_request_uses_move_request_result": "FPathFollowingRequestResult" in cpp and "MoveRequest" in cpp,
        "partial_paths_rejected": "SetAllowPartialPath(false)" in cpp,
        "request_id_stale_callback_guard": "stale_move_completion_ignored" in cpp and "ActiveRequestId.GetID()" in cpp,
        "stuck_timeout_detection": "stuck_timeout" in cpp,
        "jsonl_telemetry_writer": "ridge.botlab.telemetry.v1" in cpp and "FILEWRITE_Append" in cpp,
        "telemetry_capture_finalizes": "capture_finalized" in cpp,
        "collision_observability": "collision_impact_point_cm" in cpp and "collision_normal_impulse_magnitude" in cpp,
    }
    for name, passed in source_requirements.items():
        add("cpp_" + name, passed, "source contract present" if passed else "source contract missing")

    failed = sum(item["status"] == "FAIL" for item in checks)
    return {
        "schema": "ridge.botlab.ue-project-static-validation.v1",
        "status": "STATIC_PASS" if failed == 0 else "FAIL",
        "checks": len(checks),
        "passed": len(checks) - failed,
        "failed": failed,
        "ue_build_status": "NOT_RUN_STATIC_ONLY",
        "runtime_status": "NOT_RUN_STATIC_ONLY",
        "checks_detail": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--report-path", type=Path, default=None)
    args = parser.parse_args()
    report = validate_project(args.project_root)
    output = args.report_path or (args.project_root / "RIDGE_GIS" / "Data" / "QA" / "ridge_ue_project_static_validation.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "checks": report["checks"], "passed": report["passed"], "failed": report["failed"], "ue_build_status": report["ue_build_status"], "report": str(output)}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "STATIC_PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
