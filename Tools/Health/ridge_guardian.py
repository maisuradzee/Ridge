#!/usr/bin/env python3
"""RIDGE Guardian: auditable health checks and allow-listed self-repair.

Safe repairs are restricted to disposable/derived GIS directories and generated
world-build manifests. Source assets, database rows, secrets and UE project
settings are never edited automatically.
"""
from __future__ import annotations
import argparse
import ast
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[1]
POLICY_PATH = HERE / "health_policy.json"
UTC = dt.timezone.utc


def utc_now() -> str:
    return dt.datetime.now(UTC).isoformat(timespec="seconds")


def load_policy(path: Path = POLICY_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("project") != "RIDGE" or data.get("schema_version") != "1.0":
        raise ValueError("Unsupported or invalid RIDGE health policy")
    return data


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_project_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    candidate.relative_to(root.resolve())
    return candidate


def rotate_log(path: Path, max_bytes: int = 10 * 1024 * 1024, keep: int = 5) -> None:
    if not path.is_file() or path.stat().st_size < max_bytes:
        return
    for index in range(keep, 0, -1):
        older = path.with_name(path.name + f".{index}")
        newer = path if index == 1 else path.with_name(path.name + f".{index - 1}")
        if older.exists(): older.unlink()
        if newer.exists(): newer.rename(older)


def append_event(root: Path, event: dict[str, Any]) -> None:
    log_dir = root / "RIDGE_GIS" / "Data" / "QA"
    log_dir.mkdir(parents=True, exist_ok=True)
    event = {"timestamp": utc_now(), **event}
    log_path = log_dir / "guardian_events.jsonl"
    rotate_log(log_path)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def result(check_id: str, status: str, severity: str, detail: str, repairable: bool = False,
           evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": check_id, "status": status, "severity": severity,
            "detail": detail, "repairable": repairable, "evidence": evidence or {}}


def check_project_identity(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    path = root / "RIDGE.uproject"
    if not path.is_file():
        return result("project_identity", "FAIL", "critical", "RIDGE.uproject is missing")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return result("project_identity", "FAIL", "critical", f"RIDGE.uproject is invalid JSON: {exc}")
    expected = policy["expected_engine_association"]
    actual = str(data.get("EngineAssociation", ""))
    if actual != expected:
        return result("project_identity", "FAIL", "critical",
                      f"Expected Unreal Engine {expected}; project association is {actual or 'missing'}")
    return result("project_identity", "PASS", "info", f"RIDGE project identity valid; engine association {actual}")


def check_critical_files(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    missing = []
    for rel in policy.get("critical_files", []):
        try:
            path = safe_project_path(root, rel)
        except ValueError:
            missing.append(f"unsafe policy path: {rel}")
            continue
        if not path.is_file(): missing.append(rel)
    if missing:
        return result("critical_files", "FAIL", "critical", "Required source files are missing",
                      evidence={"missing": missing})
    return result("critical_files", "PASS", "info", "All required source files are present")


def check_data_directories(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    missing = [r for r in policy.get("required_directories", []) if not safe_project_path(root, r).is_dir()]
    if missing:
        return result("data_directories", "FAIL", "warning", "Required data folders are missing",
                      repairable=bool(policy.get("repair_policy", {}).get("create_missing_data_directories")),
                      evidence={"missing": missing})
    return result("data_directories", "PASS", "info", "Required data folders are present")


def check_python_syntax(root: Path) -> dict[str, Any]:
    scan_roots = [root / "RIDGE_GIS" / "Tools", root / "Tools" / "Health", root / "Tools" / "BotLab"]
    checked, failures = 0, []
    for base in scan_roots:
        if not base.exists(): continue
        for path in base.rglob("*.py"):
            if "__pycache__" in path.parts: continue
            checked += 1
            try:
                ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
            except Exception as exc:
                failures.append({"file": str(path.relative_to(root)), "error": str(exc)})
    if failures:
        return result("python_syntax", "FAIL", "high", "Python syntax errors detected", evidence={"files_checked": checked, "failures": failures})
    return result("python_syntax", "PASS", "info", f"Python syntax valid in {checked} files", evidence={"files_checked": checked})


def run_command(check_id: str, command: list[str], cwd: Path, timeout: int = 180) -> dict[str, Any]:
    try:
        proc = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        return result(check_id, "SKIPPED", "warning", f"Required executable not installed: {exc.filename}")
    except subprocess.TimeoutExpired:
        return result(check_id, "FAIL", "high", f"Command timed out after {timeout}s")
    output = (proc.stdout + "\n" + proc.stderr).strip()
    evidence = {"return_code": proc.returncode, "output_tail": output[-5000:]}
    if proc.returncode != 0:
        return result(check_id, "FAIL", "high", "Automated command failed", evidence=evidence)
    return result(check_id, "PASS", "info", "Automated command passed", evidence=evidence)


def check_python_tests(root: Path) -> dict[str, Any]:
    return run_command("gis_python_tests", [sys.executable, "-m", "unittest", "discover", "-s", "RIDGE_GIS/Tests", "-p", "test_*.py", "-v"], root, 240)


def check_guardian_tests(root: Path) -> dict[str, Any]:
    return run_command("guardian_tests", [sys.executable, "-m", "unittest", "discover", "-s", "Tools/Health/tests", "-p", "test_*.py", "-v"], root, 120)


def check_botlab_tests(root: Path) -> dict[str, Any]:
    path = root / "Tools" / "BotLab" / "tests"
    if not path.is_dir():
        return result("botlab_tests", "SKIPPED", "warning", "BotLab test suite is missing")
    return run_command("botlab_tests", [sys.executable, "-m", "unittest", "discover", "-s", "Tools/BotLab/tests", "-p", "test_*.py", "-v"], root, 120)


def check_botlab_simulation(root: Path) -> dict[str, Any]:
    path = root / "Tools" / "BotLab" / "botlab.py"
    if not path.is_file():
        return result("botlab_simulation", "SKIPPED", "warning", "BotLab simulator is missing")
    return run_command("botlab_simulation", [sys.executable, str(path), "--agents", "32", "--actions", "100", "--report-path", "RIDGE_GIS/Data/QA/ridge_botlab_guardian_smoke_report.json"], root, 120)


def check_botlab_interaction_contracts(root: Path) -> dict[str, Any]:
    path = root / "Tools" / "BotLab" / "interaction_contracts.py"
    if not path.is_file():
        return result("botlab_interaction_contracts", "SKIPPED", "warning", "Transactional interaction contract suite is missing")
    return run_command("botlab_interaction_contracts", [sys.executable, str(path)], root, 60)


def check_ue_telemetry(root: Path) -> dict[str, Any]:
    telemetry_dir = root / "Saved" / "RIDGE" / "BotLab"
    files = sorted(telemetry_dir.glob("movement_telemetry_*.jsonl")) if telemetry_dir.is_dir() else []
    if not files:
        return result("ue_movement_telemetry", "NOT_APPLICABLE", "info", "No completed Unreal BotLab telemetry session exists yet")
    validator = root / "Tools" / "BotLab" / "validate_ue_telemetry.py"
    if not validator.is_file():
        return result("ue_movement_telemetry", "FAIL", "high", "Unreal telemetry exists but its validator is missing")
    return run_command("ue_movement_telemetry", [sys.executable, str(validator), "--project-root", str(root)], root, 60)


def check_blockout(root: Path) -> dict[str, Any]:
    return run_command("blockout_validation", [sys.executable, "Tools/validate_blockout.py"], root, 60)


def check_player_foundation(root: Path) -> dict[str, Any]:
    path = root / "Tools" / "validate_player_foundation.py"
    if not path.is_file(): return result("player_foundation", "SKIPPED", "warning", "Player foundation validator is missing")
    return run_command("player_foundation", [sys.executable, str(path)], root, 60)


def check_mission_bridge(root: Path) -> dict[str, Any]:
    path = root / "Tools" / "validate_mission_bridge.py"
    if not path.is_file(): return result("mission_bridge", "SKIPPED", "warning", "Mission bridge validator is missing")
    return run_command("mission_bridge", [sys.executable, str(path)], root, 60)


def check_backend_tests(root: Path) -> dict[str, Any]:
    if not (root / "backend" / "package.json").is_file():
        return result("backend_tests", "SKIPPED", "warning", "Backend package.json is missing")
    return run_command("backend_tests", ["npm", "test"], root / "backend", 180)


def check_world_package(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    export_dir = safe_project_path(root, policy["worldgen_export_dir"])
    manifest = export_dir / "tile_manifest.json"
    if not manifest.is_file():
        return result("world_package", "NOT_APPLICABLE", "info", "No GIS tile_manifest exists yet; World Generator is waiting for source data")
    build_dir = export_dir / "BuildPackage"
    validator = root / "RIDGE_GIS" / "Tools" / "WorldGen" / "validate_world_package.py"
    if not build_dir.is_dir():
        return result("world_package", "FAIL", "high", "Derived BuildPackage is missing", repairable=policy["repair_policy"].get("rebuild_derived_world_package", False))
    v = run_command("world_package_validator", [sys.executable, str(validator), "--build-dir", str(build_dir)], root, 60)
    if v["status"] == "PASS":
        v["id"] = "world_package"
    else:
        v.update({"id": "world_package", "repairable": bool(policy["repair_policy"].get("rebuild_derived_world_package", False))})
    return v


def check_unreal_toolchain(root: Path) -> dict[str, Any]:
    ue_root = os.environ.get("RIDGE_UE_ROOT") or os.environ.get("UE_ROOT")
    if not ue_root:
        return result("unreal_toolchain", "SKIPPED", "warning", "Set RIDGE_UE_ROOT to verify Unreal Editor and Build Tool; this runtime is not installed in the current environment")
    base = Path(ue_root)
    candidates = [base / "Engine" / "Binaries" / "Win64" / "UnrealEditor.exe",
                  base / "Engine" / "Build" / "BatchFiles" / "Build.bat"]
    missing = [str(p) for p in candidates if not p.is_file()]
    if missing:
        return result("unreal_toolchain", "FAIL", "high", "Configured Unreal Engine root is incomplete", evidence={"missing": missing})
    return result("unreal_toolchain", "PASS", "info", "Unreal Editor and Build.bat found", evidence={"engine_root": str(base)})


def check_backend_http(base_url: str, timeout: float = 3.0) -> list[dict[str, Any]]:
    output = []
    for endpoint in ("/health", "/ready"):
        url = base_url.rstrip("/") + endpoint
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                payload = json.loads(response.read(65536).decode("utf-8"))
                if response.status != 200 or payload.get("ok") is not True:
                    raise ValueError(f"Unexpected response: HTTP {response.status}")
                if endpoint == "/ready" and payload.get("storage") == "memory-ephemeral":
                    output.append(result("backend_ready", "FAIL", "critical", "Backend is ready only with ephemeral memory storage; not acceptable for production"))
                else:
                    output.append(result("backend_" + endpoint[1:], "PASS", "info", f"{endpoint} returned healthy response", evidence={"status": response.status, "storage": payload.get("storage")}))
        except Exception as exc:
            output.append(result("backend_" + endpoint[1:], "FAIL", "high", f"{endpoint} health probe failed: {type(exc).__name__}: {exc}"))
    return output


def _zip_backup(source: Path, backup_dir: Path, keep: int) -> Path | None:
    if not source.exists(): return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    destination = backup_dir / f"BuildPackage_{stamp}.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(source.rglob("*")):
            if file.is_file(): archive.write(file, file.relative_to(source))
    backups = sorted(backup_dir.glob("BuildPackage_*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[max(1, keep):]: old.unlink(missing_ok=True)
    return destination


def repair_missing_data_directories(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    if not policy["repair_policy"].get("create_missing_data_directories", False):
        return {"repaired": False, "reason": "repair disabled by policy"}
    created = []
    for relative in policy.get("required_directories", []):
        path = safe_project_path(root, relative)
        if not path.exists():
            path.mkdir(parents=True, exist_ok=True)
            (path / ".gitkeep").touch(exist_ok=True)
            created.append(relative)
    return {"repaired": bool(created), "created": created}


def repair_world_package(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    if not policy["repair_policy"].get("rebuild_derived_world_package", False):
        return {"repaired": False, "reason": "derived build repair disabled"}
    export_dir = safe_project_path(root, policy["worldgen_export_dir"])
    manifest = export_dir / "tile_manifest.json"
    if not manifest.is_file(): return {"repaired": False, "reason": "source tile manifest is not available"}
    builder = root / "RIDGE_GIS" / "Tools" / "WorldGen" / "build_world_package.py"
    validator = root / "RIDGE_GIS" / "Tools" / "WorldGen" / "validate_world_package.py"
    if not builder.is_file() or not validator.is_file(): return {"repaired": False, "reason": "builder or validator is missing"}
    target = export_dir / "BuildPackage"
    stage = export_dir / ("BuildPackage.__repairing__" + uuid.uuid4().hex[:8])
    proc = subprocess.run([sys.executable, str(builder), "--export-dir", str(export_dir), "--output-dir", str(stage)],
                          cwd=root, capture_output=True, text=True, timeout=240, check=False)
    if proc.returncode != 0:
        shutil.rmtree(stage, ignore_errors=True)
        return {"repaired": False, "reason": "builder failed; existing source and output were left untouched",
                "output_tail": (proc.stdout + "\n" + proc.stderr)[-3000:]}
    verify = subprocess.run([sys.executable, str(validator), "--build-dir", str(stage)],
                            cwd=root, capture_output=True, text=True, timeout=60, check=False)
    if verify.returncode != 0:
        shutil.rmtree(stage, ignore_errors=True)
        return {"repaired": False, "reason": "staged output failed independent verification; existing output preserved",
                "output_tail": (verify.stdout + "\n" + verify.stderr)[-3000:]}
    backup = None
    previous = export_dir / "BuildPackage.__previous__"
    try:
        backup = _zip_backup(target, export_dir / "RecoveryBackups", int(policy["repair_policy"].get("keep_world_package_backups", 3)))
        if previous.exists(): shutil.rmtree(previous)
        if target.exists(): target.rename(previous)
        try:
            stage.rename(target)
        except Exception:
            if previous.exists() and not target.exists(): previous.rename(target)
            raise
        if previous.exists(): shutil.rmtree(previous)
    except Exception as exc:
        if stage.exists(): shutil.rmtree(stage, ignore_errors=True)
        return {"repaired": False, "reason": f"atomic promotion failed; prior output restored when possible: {exc}", "backup": str(backup) if backup else None}
    return {"repaired": True, "backup": str(backup) if backup else None,
            "detail": "Derived BuildPackage rebuilt in staging, independently validated, then promoted"}


def run_checks(root: Path, policy: dict[str, Any], full: bool = True, backend_url: str | None = None) -> list[dict[str, Any]]:
    checks = [check_project_identity(root, policy), check_critical_files(root, policy),
              check_data_directories(root, policy), check_python_syntax(root), check_blockout(root),
              check_player_foundation(root), check_mission_bridge(root)]
    if full:
        checks += [check_python_tests(root), check_guardian_tests(root), check_botlab_tests(root), check_backend_tests(root)]
    # A bounded BotLab smoke simulation runs in quick mode too, so scheduled
    # five-minute health checks actively exercise synthetic decision contracts.
    checks += [check_botlab_simulation(root), check_botlab_interaction_contracts(root),
               check_ue_telemetry(root), check_world_package(root, policy), check_unreal_toolchain(root)]
    if backend_url:
        checks += check_backend_http(backend_url, float(policy["watch"].get("http_timeout_seconds", 3)))
    return checks


def write_report(root: Path, checks: list[dict[str, Any]], repairs: list[dict[str, Any]], verified: bool,
                 mode: str) -> Path:
    qa = root / "RIDGE_GIS" / "Data" / "QA"
    qa.mkdir(parents=True, exist_ok=True)
    blocking = [c for c in checks if c["status"] == "FAIL"]
    skipped = [c for c in checks if c["status"] in ("SKIPPED", "NOT_APPLICABLE")]
    final_status = "ATTENTION_REQUIRED" if blocking else "VERIFIED_WITH_LIMITATIONS" if skipped else "VERIFIED"
    report = {"project": "RIDGE", "guardian_version": "14.0", "timestamp": utc_now(), "mode": mode,
              "status": final_status,
              "verified": final_status == "VERIFIED",
              "summary": {"checks": len(checks), "passed": sum(c["status"] == "PASS" for c in checks),
                          "failed": len([c for c in checks if c["status"] == "FAIL"]),
                          "skipped": len(skipped),
                          "repairs": len([r for r in repairs if r.get("repaired")])},
              "checks": checks, "repairs": repairs,
              "verification_note": "VERIFIED means only the checks listed here passed. It does not imply Unreal Editor, live PostgreSQL or production multiplayer was tested unless those checks explicitly ran."}
    path = qa / "ridge_health_report_v14.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    append_event(root, {"type": "health_report", "status": report["status"], "mode": mode,
                        "failed_checks": [c["id"] for c in checks if c["status"] == "FAIL"],
                        "repair_count": report["summary"]["repairs"]})
    return path


def run_once(root: Path, policy: dict[str, Any], repair: bool, full: bool, backend_url: str | None, mode: str, strict: bool = False) -> int:
    checks = run_checks(root, policy, full=full, backend_url=backend_url)
    repairs: list[dict[str, Any]] = []
    if repair:
        for check in checks:
            if check["status"] != "FAIL" or not check.get("repairable"):
                continue
            action: dict[str, Any]
            if check["id"] == "data_directories":
                action = repair_missing_data_directories(root, policy)
            elif check["id"] == "world_package":
                action = repair_world_package(root, policy)
            else:
                action = {"repaired": False, "reason": "No allow-listed repair handler"}
            repairs.append({"check_id": check["id"], **action})
            append_event(root, {"type": "repair_attempt", "check_id": check["id"], **action})
        # Re-run verification only when a repair handler was actually attempted.
        # A no-op --repair run must not double the expensive test suite.
        if repairs:
            checks = run_checks(root, policy, full=full, backend_url=backend_url)
    fail = [c for c in checks if c["status"] == "FAIL"]
    verified = len(fail) == 0
    report = write_report(root, checks, repairs, verified, mode)
    report_data = json.loads(report.read_text(encoding="utf-8"))
    print(json.dumps({"status": report_data["status"], "report": str(report),
                      "checks": [{"id": c["id"], "status": c["status"], "detail": c["detail"]} for c in checks],
                      "repairs": repairs}, ensure_ascii=False, indent=2))
    limited = report_data["status"] != "VERIFIED"
    return 2 if not verified or (strict and limited) else 0


def watch(root: Path, policy: dict[str, Any], interval: int, backend_url: str) -> int:
    timeout = float(policy["watch"].get("http_timeout_seconds", 3))
    consecutive_failures = 0
    threshold = int(policy["watch"].get("backend_consecutive_failures_before_alert", 3))
    print(f"RIDGE Guardian watch active: {backend_url} every {interval}s. Press Ctrl+C to stop.")
    try:
        while True:
            checks = check_backend_http(backend_url, timeout)
            bad = [c for c in checks if c["status"] == "FAIL"]
            if bad:
                consecutive_failures += 1
            else:
                consecutive_failures = 0
            state = "HEALTHY" if not bad else "DEGRADED" if consecutive_failures < threshold else "ALERT"
            append_event(root, {"type": "watch_probe", "state": state,
                                "consecutive_failures": consecutive_failures,
                                "checks": [{"id": c["id"], "status": c["status"]} for c in checks]})
            print(f"{utc_now()} {state} ({consecutive_failures}/{threshold})")
            time.sleep(max(5, interval))
    except KeyboardInterrupt:
        print("RIDGE Guardian watch stopped.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    ap.add_argument("--policy", type=Path, default=POLICY_PATH)
    ap.add_argument("--repair", action="store_true", help="Apply only allow-listed reversible repairs, then rerun verification")
    ap.add_argument("--quick", action="store_true", help="Skip full automated regression suites")
    ap.add_argument("--backend-url", default=None, help="Also probe /health and /ready")
    ap.add_argument("--strict", action="store_true", help="Return failure unless every configured check ran and passed (no SKIPPED/NOT_APPLICABLE)")
    ap.add_argument("--watch", action="store_true", help="Continuously probe the backend only")
    ap.add_argument("--interval", type=int, default=30)
    args = ap.parse_args()
    root = args.project_root.resolve()
    policy = load_policy(args.policy)
    if args.watch:
        if not args.backend_url: ap.error("--watch requires --backend-url")
        return watch(root, policy, args.interval, args.backend_url)
    return run_once(root, policy, repair=args.repair, full=not args.quick,
                    backend_url=args.backend_url, mode="repair" if args.repair else "check", strict=args.strict)

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as exc:
        print(f"RIDGE Guardian fatal error: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(3)
