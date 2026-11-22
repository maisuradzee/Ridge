#!/usr/bin/env python3
"""Validate completed Unreal BotLab movement telemetry sessions."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
from typing import Any

TERMINAL = {"completed", "cancelled", "failed"}
ROUTE_EVENTS = {"waypoint_requested", "waypoint_already_reached", "waypoint_reached", "route_terminal", "movement_sample"}


def _finite_vector(value: Any, length: int = 3) -> bool:
    return (isinstance(value, list) and len(value) == length
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value))


def validate_file(path: Path) -> dict[str, Any]:
    errors: list[str] = []
    observability_gaps: list[str] = []
    events: list[dict[str, Any]] = []
    try:
        for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append(f"line_{line_no}_invalid_json:{exc.msg}")
                continue
            if not isinstance(item, dict):
                errors.append(f"line_{line_no}_event_is_not_an_object")
                continue
            if item.get("schema") != "ridge.botlab.telemetry.v1":
                errors.append(f"line_{line_no}_wrong_schema")
            if not item.get("controller_session_id"):
                errors.append(f"line_{line_no}_missing_controller_session_id")
            if not item.get("event"):
                errors.append(f"line_{line_no}_missing_event")
            missing = item.get("observability_missing_fields", [])
            if not isinstance(missing, list):
                errors.append(f"line_{line_no}_observability_missing_fields_not_array")
            elif missing:
                observability_gaps.extend(f"line_{line_no}:{field}" for field in missing)
            events.append(item)
    except OSError as exc:
        return {"file": str(path), "valid": False, "errors": [f"file_read_error:{exc}"]}

    if not events:
        errors.append("empty_telemetry_file")
        return {"file": str(path), "valid": False, "errors": errors, "observability_gaps": observability_gaps}

    session_ids = {e.get("controller_session_id") for e in events}
    if len(session_ids) != 1:
        errors.append("multiple_or_missing_controller_sessions_in_single_file")
    if events[0].get("event") != "controller_ready":
        errors.append("controller_ready_must_be_first_event")
    if sum(e.get("event") == "controller_ready" for e in events) != 1:
        errors.append("controller_ready_must_appear_exactly_once")
    finalized_positions = [i for i, e in enumerate(events) if e.get("event") == "capture_finalized"]
    if len(finalized_positions) != 1:
        errors.append("capture_finalized_must_appear_exactly_once")
    elif finalized_positions[0] != len(events) - 1:
        errors.append("events_found_after_capture_finalized")

    routes: dict[str, dict[str, Any]] = {}
    seen_generations: set[int] = set()
    last_generation = 0
    for idx, event in enumerate(events, 1):
        name = event.get("event")
        route_id = event.get("route_id")
        if name == "route_started":
            generation = event.get("route_generation")
            if not isinstance(route_id, str) or not route_id:
                errors.append(f"event_{idx}_route_started_without_id")
                continue
            if route_id in routes:
                errors.append(f"event_{idx}_duplicate_route_started:{route_id}")
            if event.get("route_state") != "moving":
                errors.append(f"event_{idx}_route_started_not_moving:{route_id}")
            if not isinstance(generation, int) or isinstance(generation, bool) or generation <= last_generation or generation in seen_generations:
                errors.append(f"event_{idx}_route_generation_not_monotonic:{generation}")
            elif isinstance(generation, int):
                last_generation = generation
                seen_generations.add(generation)
            routes[route_id] = {"started": True, "terminal": None, "waypoints_requested": 0, "waypoints_reached": 0,
                                "generation": generation}
            continue

        if name in ROUTE_EVENTS:
            if route_id not in routes:
                errors.append(f"event_{idx}_route_event_without_route:{name}:{route_id}")
                continue
            route = routes[route_id]
            if route["terminal"] is not None:
                errors.append(f"event_{idx}_route_event_after_terminal:{route_id}:{name}")
                continue
            if name != "route_terminal" and event.get("route_state") != "moving":
                errors.append(f"event_{idx}_nonterminal_event_not_moving:{route_id}:{name}")
            if name == "waypoint_requested":
                request_id = event.get("active_request_id")
                if not isinstance(request_id, (int, float)) or request_id < 0:
                    errors.append(f"event_{idx}_waypoint_request_missing_id:{route_id}")
                route["waypoints_requested"] += 1
            elif name == "waypoint_already_reached":
                route["waypoints_reached"] += 1
            elif name == "waypoint_reached":
                route["waypoints_reached"] += 1
            elif name == "movement_sample":
                required = ("actor_position_cm", "actor_rotation_deg", "speed_cm_s", "movement_mode_id", "custom_movement_mode_id", "nav_path_status", "nav_partial_path", "observability_missing_fields")
                for key in required:
                    if key not in event:
                        errors.append(f"event_{idx}_movement_sample_missing_{key}")
                if "actor_position_cm" in event and event["actor_position_cm"] is not None and not _finite_vector(event["actor_position_cm"]):
                    errors.append(f"event_{idx}_invalid_actor_position")
                if "actor_rotation_deg" in event and event["actor_rotation_deg"] is not None and not _finite_vector(event["actor_rotation_deg"]):
                    errors.append(f"event_{idx}_invalid_actor_rotation")
                speed = event.get("speed_cm_s")
                if speed is not None and (not isinstance(speed, (int, float)) or isinstance(speed, bool) or not math.isfinite(speed) or speed < 0):
                    errors.append(f"event_{idx}_invalid_speed")
                for key in ("movement_mode_id", "custom_movement_mode_id"):
                    value = event.get(key)
                    if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
                        errors.append(f"event_{idx}_invalid_{key}")
                if event.get("nav_path_status") not in {"moving", "paused", "idle", None}:
                    errors.append(f"event_{idx}_invalid_nav_path_status")
            elif name == "route_terminal":
                state = event.get("route_state")
                if state not in TERMINAL:
                    errors.append(f"event_{idx}_invalid_terminal_state:{state}")
                if route["terminal"] is not None:
                    errors.append(f"event_{idx}_duplicate_terminal:{route_id}")
                route["terminal"] = state

        if name == "pawn_collision":
            required = ("collision_impact_point_cm", "collision_impact_normal", "collision_other_actor_class", "collision_object_channel", "collision_physical_material", "collision_normal_impulse_magnitude")
            for key in required:
                if key not in event:
                    errors.append(f"event_{idx}_collision_missing_{key}")
            for key in ("collision_impact_point_cm", "collision_impact_normal"):
                if key in event and event[key] is not None and not _finite_vector(event[key]):
                    errors.append(f"event_{idx}_invalid_{key}")
            impulse = event.get("collision_normal_impulse_magnitude")
            if impulse is not None and (not isinstance(impulse, (int, float)) or isinstance(impulse, bool) or not math.isfinite(impulse) or impulse < 0):
                errors.append(f"event_{idx}_invalid_collision_normal_impulse_magnitude")

    for route_id, route in routes.items():
        if route["terminal"] is None:
            errors.append(f"route_not_terminal:{route_id}")

    route_count = len(routes)
    if route_count and not any(e.get("event") == "capture_finalized" for e in events):
        errors.append("capture_not_finalized")
    if any(e.get("event") == "controller_end_play" for e in events):
        end_positions = [i for i, e in enumerate(events) if e.get("event") == "controller_end_play"]
        if len(end_positions) != 1 or end_positions[0] != len(events) - 2:
            errors.append("controller_end_play_must_precede_capture_finalized")

    return {"file": str(path), "valid": not errors, "errors": errors,
            "observability_gaps": observability_gaps,
            "event_count": len(events), "route_count": route_count,
            "route_outcomes": {state: sum(r["terminal"] == state for r in routes.values()) for state in sorted(TERMINAL)},
            "movement_samples": sum(e.get("event") == "movement_sample" for e in events),
            "collision_events": sum(e.get("event") == "pawn_collision" for e in events)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[2])
    ap.add_argument("--telemetry-dir", type=Path, default=None)
    ap.add_argument("--report-path", type=Path, default=None)
    args = ap.parse_args()
    base = args.telemetry_dir or (args.project_root / "Saved" / "RIDGE" / "BotLab")
    files = sorted(base.glob("movement_telemetry_*.jsonl")) if base.exists() else []
    sessions = [validate_file(p) for p in files]
    report = {"schema": "ridge.botlab.ue-telemetry-validation.v1", "status": "NOT_APPLICABLE" if not files else "PASS",
              "sessions_found": len(files), "sessions": sessions,
              "observability_gap_count": sum(len(s.get("observability_gaps", [])) for s in sessions)}
    if files and any(not s["valid"] for s in sessions):
        report["status"] = "FAIL"
    report_path = args.report_path or (args.project_root / "RIDGE_GIS" / "Data" / "QA" / "ridge_ue_telemetry_validation.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "sessions_found": report["sessions_found"], "report": str(report_path),
                      "invalid_sessions": sum(not s["valid"] for s in sessions),
                      "observability_gap_count": report["observability_gap_count"]}, ensure_ascii=False, indent=2))
    return 2 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())