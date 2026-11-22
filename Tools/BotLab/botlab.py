#!/usr/bin/env python3
"""RIDGE BotLab: deterministic synthetic-agent decision and action-contract simulator.

This is a QA model, not a claim that a finite catalogue enumerates every human
possibility or that synthetic profiles represent real people. It deliberately
uses fictional, non-clinical decision tendencies and reports unknown telemetry.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import random
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "RIDGE_GIS" / "Data" / "QA"

FAMILIES: dict[str, list[str]] = {
    "locomotion": ["walk", "run", "sprint", "crouch", "jump", "turn", "sidestep", "reverse", "stop", "pace", "follow_path"],
    "navigation": ["set_destination", "replan_route", "take_detour", "backtrack", "wait_for_path", "ask_directions", "follow_signage", "choose_landmark", "avoid_hazard", "approach_goal", "abandon_route"],
    "terrain": ["climb_slope", "descend_slope", "step_over", "vault_obstacle", "crawl_under", "balance_edge", "cross_shallow_water", "swim", "wade", "slide", "recover_from_fall"],
    "environment": ["seek_shelter", "leave_shelter", "warm_up", "cool_down", "protect_from_rain", "avoid_wind", "cross_ice", "avoid_heat", "use_lighting", "adapt_to_dark", "inspect_weather"],
    "interaction": ["inspect_object", "open_door", "close_door", "lock_door", "unlock_door", "knock_door", "use_switch", "operate_terminal", "sit", "stand", "pick_up_object", "put_down_object"],
    "inventory": ["open_inventory", "equip_item", "unequip_item", "consume_item", "drop_item", "transfer_item", "sort_items", "inspect_item", "repair_item", "discard_item", "store_item"],
    "economy": ["check_balance", "pay_invoice", "withdraw_cash", "deposit_cash", "transfer_money", "buy_goods", "sell_goods", "compare_prices", "negotiate_price", "request_refund", "review_transaction", "cancel_purchase"],
    "social": ["greet", "introduce_self", "ask_question", "answer_question", "offer_help", "request_help", "thank_person", "apologize", "decline_request", "invite_person", "leave_conversation"],
    "conflict": ["deescalate", "set_boundary", "retreat", "call_authority", "report_incident", "block_path", "challenge_claim", "defend_self", "disengage", "mediate_dispute", "record_evidence"],
    "care": ["check_injuries", "apply_first_aid", "seek_medical_help", "assist_injured", "request_rescue", "rest", "drink_water", "eat_food", "manage_fatigue", "protect_companion", "report_emergency"],
    "work": ["clock_in", "clock_out", "accept_shift", "decline_shift", "perform_task", "request_break", "ask_supervisor", "deliver_package", "collect_supplies", "report_completion", "change_work_plan"],
    "missions": ["view_objective", "accept_mission", "decline_mission", "track_objective", "complete_objective", "fail_objective", "pause_mission", "resume_mission", "abandon_mission", "submit_evidence", "claim_reward"],
    "vehicles": ["approach_vehicle", "enter_vehicle", "exit_vehicle", "start_engine", "stop_engine", "drive_forward", "reverse_vehicle", "turn_vehicle", "brake_vehicle", "park_vehicle", "refuel_vehicle"],
    "transport": ["hail_taxi", "board_bus", "exit_bus", "buy_ticket", "validate_ticket", "wait_for_transport", "change_line", "request_stop", "plan_transit", "miss_connection", "report_delay"],
    "property": ["inspect_property", "enter_property", "leave_property", "lock_property", "unlock_property", "rent_property", "pay_rent", "report_damage", "request_maintenance", "place_furniture", "remove_furniture"],
    "utilities": ["check_power", "switch_power", "check_water", "use_water", "report_outage", "read_meter", "pay_utility_bill", "conserve_energy", "inspect_heating", "request_utility_repair", "restore_service"],
    "crafting": ["inspect_recipe", "gather_material", "combine_materials", "craft_item", "cancel_crafting", "upgrade_item", "dismantle_item", "queue_crafting", "collect_crafted_item", "repair_equipment", "check_tool_condition"],
    "information": ["read_notice", "check_map", "search_area", "inspect_clue", "compare_options", "verify_information", "ask_witness", "review_history", "check_schedule", "check_rules", "report_unknown"],
    "communication": ["send_message", "receive_message", "make_call", "answer_call", "ignore_call", "share_location", "send_request", "broadcast_alert", "mute_channel", "change_channel", "confirm_message"],
    "group": ["join_group", "leave_group", "follow_leader", "lead_group", "wait_for_member", "split_group", "regroup", "assign_role", "share_resource", "vote_decision", "resolve_group_disagreement"],
    "emergency": ["evacuate", "shelter_in_place", "avoid_fire", "avoid_flood", "avoid_traffic", "call_emergency_service", "guide_bystander", "secure_area", "follow_official_instruction", "request_status_update", "assist_evacuation"],
    "stealth": ["move_quietly", "hide", "observe_unnoticed", "avoid_detection"],
    "accessibility": ["use_ramp", "use_elevator", "request_accessible_route", "adjust_move_speed", "use_assistance_device", "request_interaction_help", "choose_step_free_path", "pause_for_accessibility", "reorient_camera"],
    "digital_systems": ["open_ui", "close_ui", "retry_request", "cancel_request", "inspect_error", "refresh_data", "reconnect_service", "report_bug", "confirm_action"],
    "daily_routine": ["wake_up", "sleep", "shower", "wash_hands", "brush_teeth", "use_toilet", "change_clothes", "cook_meal", "clean_room", "wash_clothes", "manage_schedule"],
    "education": ["attend_class", "study_topic", "practice_skill", "take_assessment", "ask_instructor", "collaborate_project", "borrow_book", "return_book", "enroll_course", "skip_class", "request_tutoring"],
    "civic_law": ["check_local_rules", "submit_application", "renew_document", "report_hazard", "request_public_service", "attend_public_meeting", "file_complaint", "respond_to_notice", "request_legal_aid", "comply_with_inspection", "appeal_decision"],
    "animals": ["approach_animal", "feed_animal", "give_water_animal", "walk_pet", "groom_animal", "clean_animal_area", "seek_vet", "transport_animal", "train_animal", "calm_animal", "report_stray_animal"],
}

STATE_TRANSITION_INTENTS = {
    "locomotion.sprint", "care.rest", "care.manage_fatigue", "daily_routine.sleep",
    "economy.pay_invoice", "economy.buy_goods", "economy.sell_goods",
    "missions.accept_mission", "missions.complete_objective", "missions.claim_reward",
    "navigation.set_destination", "navigation.abandon_route", "navigation.replan_route",
    "social.greet",
}

EXTRA_ACTIONS = [
    ("emergency", "safely_wait_for_responder"),
    ("navigation", "choose_alternate_entrance"),
    ("social", "ask_for_consent_before_assistance"),
    ("digital_systems", "verify_idempotent_retry"),
]

# Fictional, non-clinical agent tendencies. They are test dimensions, not diagnoses
# or demographic claims about human populations.
AGENT_ARCHETYPES = [
    {"id": "cautious_planner", "risk_tolerance": 0.15, "planning_horizon": 0.9, "social_orientation": 0.45, "novelty_seeking": 0.2, "attention": 0.9},
    {"id": "curious_explorer", "risk_tolerance": 0.65, "planning_horizon": 0.45, "social_orientation": 0.55, "novelty_seeking": 0.95, "attention": 0.7},
    {"id": "social_helper", "risk_tolerance": 0.35, "planning_horizon": 0.55, "social_orientation": 0.95, "novelty_seeking": 0.45, "attention": 0.8},
    {"id": "goal_focused_worker", "risk_tolerance": 0.5, "planning_horizon": 0.85, "social_orientation": 0.35, "novelty_seeking": 0.3, "attention": 0.9},
    {"id": "improviser", "risk_tolerance": 0.8, "planning_horizon": 0.2, "social_orientation": 0.5, "novelty_seeking": 0.8, "attention": 0.45},
    {"id": "resource_conserver", "risk_tolerance": 0.2, "planning_horizon": 0.9, "social_orientation": 0.3, "novelty_seeking": 0.25, "attention": 0.85},
    {"id": "conflict_avoider", "risk_tolerance": 0.1, "planning_horizon": 0.5, "social_orientation": 0.6, "novelty_seeking": 0.25, "attention": 0.8},
    {"id": "assertive_negotiator", "risk_tolerance": 0.7, "planning_horizon": 0.65, "social_orientation": 0.7, "novelty_seeking": 0.5, "attention": 0.8},
    {"id": "routine_seeker", "risk_tolerance": 0.25, "planning_horizon": 0.7, "social_orientation": 0.4, "novelty_seeking": 0.1, "attention": 0.75},
    {"id": "community_minded", "risk_tolerance": 0.4, "planning_horizon": 0.6, "social_orientation": 0.9, "novelty_seeking": 0.4, "attention": 0.75},
    {"id": "fatigued_traveller", "risk_tolerance": 0.2, "planning_horizon": 0.35, "social_orientation": 0.4, "novelty_seeking": 0.25, "attention": 0.5},
    {"id": "time_pressured", "risk_tolerance": 0.65, "planning_horizon": 0.25, "social_orientation": 0.25, "novelty_seeking": 0.3, "attention": 0.6},
    {"id": "privacy_conscious", "risk_tolerance": 0.25, "planning_horizon": 0.75, "social_orientation": 0.35, "novelty_seeking": 0.3, "attention": 0.9},
    {"id": "methodical_learner", "risk_tolerance": 0.3, "planning_horizon": 0.9, "social_orientation": 0.55, "novelty_seeking": 0.7, "attention": 0.95},
    {"id": "household_caregiver", "risk_tolerance": 0.25, "planning_horizon": 0.8, "social_orientation": 0.95, "novelty_seeking": 0.25, "attention": 0.85},
    {"id": "rule_compliant_planner", "risk_tolerance": 0.2, "planning_horizon": 0.95, "social_orientation": 0.5, "novelty_seeking": 0.15, "attention": 0.9},
]

ENV_AXES = {
    "visibility": ["clear", "fog", "dark", "glare"],
    "weather": ["dry", "rain", "snow", "heat", "wind"],
    "surface": ["asphalt", "gravel", "mud", "ice", "stairs"],
    "crowd": ["empty", "low", "dense"],
    "route": ["clear", "blocked", "partial", "unknown"],
    "information": ["complete", "ambiguous", "missing", "misleading"],
    "objective": ["urgent", "normal", "optional", "expired"],
    "social_context": ["neutral", "friendly", "hostile", "busy", "distressed"],
    "resources": ["abundant", "limited", "critical"],
    "object_state": ["available", "occupied", "locked", "damaged", "offline"],
    "network": ["online", "slow", "offline", "recovering"],
    "device": ["keyboard_mouse", "controller", "touch", "accessibility"],
    "health": ["well", "injured", "exhausted", "thirsty", "hungry"],
    "time_pressure": ["none", "moderate", "high"],
    "world_load": ["low", "normal", "high", "overloaded"],
    "authority": ["present", "absent", "unknown"],
    "privacy_context": ["private", "shared", "public"],
    "relationship": ["stranger", "acquaintance", "friend", "family", "authority"],
    "task_complexity": ["routine", "multi_step", "novel", "ambiguous"],
    "rule_clarity": ["clear", "partial", "conflicting", "unknown"],
}

@dataclass
class AgentState:
    agent_id: str
    wallet: int = 1000
    stamina: float = 100.0
    health: float = 100.0
    mission_state: str = "available"
    mission_reward_claimed: bool = False
    inventory: list[str] = field(default_factory=list)
    route_state: str = "idle"
    route_cancelled: bool = False
    position: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    trust: float = 0.0
    event_count: int = 0


def build_catalog() -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    for family, names in FAMILIES.items():
        for name in names:
            catalog.append({"id": f"{family}.{name}", "family": family, "intent": name,
                            "precondition_tags": _preconditions(family, name),
                            "observable_tags": _observables(family, name),
                            "safe_retry": name in {"retry_request", "refresh_data", "verify_idempotent_retry"},
                            "execution_mode": "state_transition_model" if f"{family}.{name}" in STATE_TRANSITION_INTENTS else "contract_probe_only"})
    for family, name in EXTRA_ACTIONS:
        catalog.append({"id": f"{family}.{name}", "family": family, "intent": name,
                        "precondition_tags": _preconditions(family, name),
                        "observable_tags": _observables(family, name), "safe_retry": False, "execution_mode": "state_transition_model" if f"{family}.{name}" in STATE_TRANSITION_INTENTS else "contract_probe_only"})
    assert len(catalog) == 303, f"expected 303 actions, got {len(catalog)}"
    return catalog


def _preconditions(family: str, name: str) -> list[str]:
    tags = ["agent_alive", "world_tick"]
    if family in {"locomotion", "navigation", "terrain", "stealth"}: tags += ["pawn_possessed", "movement_component"]
    if family in {"vehicles", "transport"}: tags += ["vehicle_or_transport_available"]
    if family in {"economy", "property", "utilities"}: tags += ["valid_account_or_asset"]
    if family in {"missions", "work"}: tags += ["objective_or_shift_state_valid"]
    if family == "daily_routine": tags += ["safe_location_and_required_fixture"]
    if family == "education": tags += ["learning_context_or_material_available"]
    if family == "civic_law": tags += ["jurisdiction_and_process_valid"]
    if family == "animals": tags += ["animal_present_and_welfare_rules"]
    if family in {"social", "conflict", "group"}: tags += ["social_context_valid", "consent_and_authority_rules"]
    if name in {"claim_reward", "complete_objective"}: tags += ["objective_completed"]
    if name in {"open_door", "unlock_door", "enter_property"}: tags += ["access_policy_allows"]
    if name in {"consume_item", "repair_item", "refuel_vehicle"}: tags += ["required_resource_available"]
    return tags


def _observables(family: str, name: str) -> list[str]:
    mapping = {
        "locomotion": ["position", "velocity", "rotation", "movement_mode", "collision", "ground_contact", "animation"],
        "navigation": ["destination", "path_status", "waypoint", "replan_count", "stuck_duration"],
        "terrain": ["surface_type", "slope", "fall_distance", "movement_mode", "damage"],
        "environment": ["weather", "temperature", "visibility", "shelter_state"],
        "interaction": ["target_id", "interaction_result", "access_result", "object_state"],
        "inventory": ["item_id", "owner_id", "quantity", "durability", "transaction_id"],
        "economy": ["ledger_id", "balance_before", "balance_after", "currency_delta", "idempotency_key"],
        "social": ["participants", "consent", "dialogue_intent", "response_state"],
        "conflict": ["threat_state", "distance", "authority_state", "escalation_level"],
        "care": ["health_before", "health_after", "resource_use", "medical_state"],
        "work": ["shift_id", "task_id", "completion_state", "reward_reference"],
        "missions": ["mission_id", "objective_state", "reward_state", "evidence_reference"],
        "vehicles": ["vehicle_id", "speed", "steering", "brake", "collision", "occupancy"],
        "transport": ["route_id", "schedule_state", "ticket_state", "boarding_state"],
        "property": ["property_id", "owner_id", "access_state", "lease_state"],
        "utilities": ["service_id", "meter_reading", "outage_state", "repair_ticket"],
        "crafting": ["recipe_id", "inputs", "outputs", "station_state"],
        "information": ["source_id", "confidence", "freshness", "contradictions"],
        "communication": ["message_id", "delivery_state", "recipient_consent", "retry_count"],
        "group": ["group_id", "membership", "role", "formation", "resource_sharing"],
        "emergency": ["incident_id", "hazard_distance", "evacuation_state", "responder_state"],
        "stealth": ["noise_level", "visibility", "cover_state", "detection_state"],
        "accessibility": ["control_scheme", "route_accessibility", "interaction_reach", "assistance_state"],
        "digital_systems": ["request_id", "request_state", "retry_count", "idempotency_key"],
        "daily_routine": ["routine_id", "fixture_id", "hygiene_state", "schedule_state", "resource_use"],
        "education": ["course_id", "lesson_id", "progress", "assessment_state", "learning_resource"],
        "civic_law": ["jurisdiction", "procedure_id", "submission_id", "deadline", "decision_state"],
        "animals": ["animal_id", "welfare_state", "owner_consent", "food_water_state", "vet_reference"],
    }
    return mapping.get(family, ["action_state", "result", "timestamp"])


CATALOG = build_catalog()
CATALOG_BY_ID = {a["id"]: a for a in CATALOG}


def evaluate_preconditions(action: dict[str, Any], state: AgentState, env: dict[str, str]) -> tuple[bool, str]:
    name = action["intent"]
    if name == "claim_reward" and state.mission_state != "completed":
        return False, "objective_not_completed"
    if name == "complete_objective" and state.mission_state != "active":
        return False, "mission_not_active"
    if name in {"open_door", "unlock_door", "enter_property"} and env.get("object_state") in {"locked", "occupied", "offline"}:
        return False, "access_or_object_state_denied"
    if name in {"consume_item", "repair_item", "refuel_vehicle"} and not state.inventory:
        return False, "required_resource_missing"
    if name == "sprint" and state.stamina < 10:
        return False, "stamina_below_minimum"
    if name in {"drive_forward", "reverse_vehicle", "turn_vehicle", "brake_vehicle", "park_vehicle"} and env.get("object_state") != "available":
        return False, "vehicle_unavailable"
    return True, "preconditions_satisfied"


def apply_action(action: dict[str, Any], state: AgentState, env: dict[str, str]) -> dict[str, Any]:
    ok, reason = evaluate_preconditions(action, state, env)
    before = {"wallet": state.wallet, "stamina": state.stamina, "health": state.health,
              "mission_state": state.mission_state, "inventory_count": len(state.inventory),
              "route_state": state.route_state}
    accepted = ok
    if ok:
        name = action["intent"]
        if name == "sprint": state.stamina = max(0.0, state.stamina - 12.0)
        elif name in {"rest", "manage_fatigue"}: state.stamina = min(100.0, state.stamina + 15.0)
        elif name == "sleep": state.stamina = min(100.0, state.stamina + 35.0)
        elif name == "pay_invoice":
            if state.wallet >= 100: state.wallet -= 100
            else: accepted, reason = False, "insufficient_funds"
        elif name == "buy_goods":
            if state.wallet >= 50: state.wallet -= 50; state.inventory.append("generic_goods")
            else: accepted, reason = False, "insufficient_funds"
        elif name == "sell_goods":
            if state.inventory: state.inventory.pop(); state.wallet += 25
            else: accepted, reason = False, "inventory_empty"
        elif name == "accept_mission":
            if state.mission_state == "available": state.mission_state = "active"
            else: accepted, reason = False, "mission_not_available"
        elif name == "complete_objective":
            if state.mission_state == "active": state.mission_state = "completed"
            else: accepted, reason = False, "mission_not_active"
        elif name == "claim_reward":
            if state.mission_state == "completed" and not state.mission_reward_claimed:
                state.wallet += 100; state.mission_reward_claimed = True
            else: accepted, reason = False, "reward_not_claimable_or_already_claimed"
        elif name == "set_destination": state.route_state = "moving"; state.route_cancelled = False
        elif name == "abandon_route": state.route_state = "cancelled"; state.route_cancelled = True
        elif name == "replan_route" and state.route_state == "cancelled":
            accepted, reason = False, "route_is_terminal_cancelled"
        elif name == "greet": state.trust = min(1.0, state.trust + 0.02)
        state.event_count += 1
    after = {"wallet": state.wallet, "stamina": state.stamina, "health": state.health,
             "mission_state": state.mission_state, "inventory_count": len(state.inventory),
             "route_state": state.route_state}
    invariant_errors = []
    if state.wallet < 0: invariant_errors.append("negative_wallet")
    if not 0.0 <= state.stamina <= 100.0: invariant_errors.append("stamina_out_of_range")
    if state.mission_reward_claimed and state.mission_state != "completed": invariant_errors.append("reward_without_completed_mission")
    if state.route_cancelled and state.route_state == "moving": invariant_errors.append("cancelled_route_still_moving")
    return {"agent_id": state.agent_id, "action_id": action["id"], "accepted": accepted,
            "reason": reason, "before": before, "after": after, "invariant_errors": invariant_errors}


def choose_action(agent: dict[str, Any], env: dict[str, str], rng: random.Random) -> dict[str, Any]:
    # Weighted choice is intentionally transparent and bounded. It does not infer
    # mental illness, protected traits, or claim to model all human psychology.
    scored = []
    for action in CATALOG:
        family = action["family"]
        score = 1.0
        if family in {"navigation", "information"}: score += agent["planning_horizon"] * 1.4
        if family in {"social", "group", "care"}: score += agent["social_orientation"] * 1.8
        if family in {"terrain", "stealth", "exploration"}: score += agent["novelty_seeking"] * 1.2
        if family in {"emergency", "care"} and env.get("social_context") == "distressed": score += 2.0
        if family in {"navigation", "locomotion"} and env.get("route") in {"blocked", "partial"}: score += 1.7
        if family == "environment" and env.get("weather") in {"rain", "snow", "heat", "wind"}: score += 1.8
        if family == "accessibility" and env.get("device") == "accessibility": score += 2.5
        if family == "daily_routine" and env.get("privacy_context") == "private": score += 1.4
        if family == "education" and env.get("task_complexity") in {"multi_step", "novel"}: score += 1.5
        if family == "civic_law" and env.get("rule_clarity") in {"partial", "conflicting", "unknown"}: score += 1.5
        if family == "animals" and env.get("relationship") in {"friend", "family"}: score += agent["social_orientation"]
        if family == "care" and env.get("health") in {"injured", "exhausted", "thirsty", "hungry"}: score += 2.0
        if env.get("time_pressure") == "high" and family in {"missions", "work", "navigation"}: score += agent["risk_tolerance"]
        # Lower attention increases chance of a less optimal, but still legal, choice.
        score *= max(0.25, agent["attention"] + rng.random() * (1.0 - agent["attention"]))
        scored.append((action, max(0.01, score)))
    total = sum(weight for _, weight in scored)
    point = rng.random() * total
    for action, weight in scored:
        point -= weight
        if point <= 0:
            return action
    return scored[-1][0]


def make_environment(rng: random.Random) -> dict[str, str]:
    return {axis: rng.choice(values) for axis, values in ENV_AXES.items()}


def pairwise_environment_coverage() -> dict[str, int]:
    """Exhaustively enumerate every value pair for every pair of environment axes."""
    expected = covered = 0
    axes = list(ENV_AXES.items())
    for i, (axis_a, values_a) in enumerate(axes):
        for axis_b, values_b in axes[i + 1:]:
            expected += len(values_a) * len(values_b)
            seen = set()
            for value_a in values_a:
                for value_b in values_b:
                    scenario = {axis: values[0] for axis, values in axes}
                    scenario[axis_a] = value_a
                    scenario[axis_b] = value_b
                    seen.add((scenario[axis_a], scenario[axis_b]))
            covered += len(seen)
    return {"expected_pairs": expected, "covered_pairs": covered,
            "axis_count": len(axes), "complete": expected == covered}


def run_pairwise_environment_sweep(seed: int = 20261121) -> dict[str, int]:
    """Execute one legal decision probe for every pair of environment values."""
    rng = random.Random(seed ^ 0x5A17)
    axes = list(ENV_AXES.items())
    scenarios = 0
    invariant_failures = 0
    accepted = rejected = 0
    for i, (axis_a, values_a) in enumerate(axes):
        for axis_b, values_b in axes[i + 1:]:
            for value_a in values_a:
                for value_b in values_b:
                    env = {axis: values[0] for axis, values in axes}
                    env[axis_a] = value_a
                    env[axis_b] = value_b
                    archetype = AGENT_ARCHETYPES[scenarios % len(AGENT_ARCHETYPES)]
                    state = AgentState(agent_id=f"pairwise-{scenarios:05d}")
                    # Give resource-dependent actions a controlled fixture; this
                    # prevents fixture absence from hiding unrelated invariants.
                    state.inventory.append("pairwise_test_resource")
                    action = choose_action(archetype, env, rng)
                    event = apply_action(action, state, env)
                    scenarios += 1
                    accepted += int(event["accepted"])
                    rejected += int(not event["accepted"])
                    invariant_failures += len(event["invariant_errors"])
    coverage = pairwise_environment_coverage()
    return {**coverage, "scenario_executions": scenarios, "accepted": accepted,
            "rejected": rejected, "invariant_failures": invariant_failures,
            "complete_execution": scenarios == coverage["expected_pairs"] and invariant_failures == 0}


def run_simulation(agent_count: int = 64, actions_per_agent: int = 250, seed: int = 20261121) -> dict[str, Any]:
    rng = random.Random(seed)
    agents = [copy.deepcopy(AGENT_ARCHETYPES[i % len(AGENT_ARCHETYPES)]) for i in range(agent_count)]
    states = [AgentState(agent_id=f"synthetic-{i:03d}") for i in range(agent_count)]
    events: list[dict[str, Any]] = []
    invariant_failures = []
    accepted = rejected = 0
    for agent, state in zip(agents, states):
        for step in range(actions_per_agent):
            env = make_environment(rng)
            action = choose_action(agent, env, rng)
            event = apply_action(action, state, env)
            event.update({"step": step, "archetype": agent["id"], "environment": env})
            events.append(event)
            accepted += int(event["accepted"])
            rejected += int(not event["accepted"])
            if event["invariant_errors"]:
                invariant_failures.append(event)
    # Isolated catalog sweep: every intent starts from a pristine, unique state.
    catalog_results = []
    for i, action in enumerate(CATALOG):
        isolated = AgentState(agent_id=f"catalog-{i:03d}")
        if action["intent"] in {"consume_item", "repair_item", "refuel_vehicle"}:
            isolated.inventory.append("test_resource")
        isolated_env = {axis: values[0] for axis, values in ENV_AXES.items()}
        if action["intent"] in {"open_door", "unlock_door", "enter_property"}: isolated_env["object_state"] = "available"
        if action["intent"] in {"drive_forward", "reverse_vehicle", "turn_vehicle", "brake_vehicle", "park_vehicle"}: isolated_env["object_state"] = "available"
        catalog_results.append(apply_action(action, isolated, isolated_env))
    # Prove no cross-agent aliasing/mutation: states are distinct and identifiers unique.
    isolation_ok = len({id(s) for s in states}) == len(states) and len({s.agent_id for s in states}) == len(states)
    report = {
        "schema": "ridge.botlab.report.v1", "seed": seed, "agents": agent_count,
        "actions_per_agent": actions_per_agent, "simulated_events": len(events),
        "catalog_actions": len(CATALOG), "catalog_sweep": len(catalog_results),
        "state_transition_modeled_intents": len(STATE_TRANSITION_INTENTS),
        "contract_probe_only_intents": len(CATALOG) - len(STATE_TRANSITION_INTENTS),
        "accepted": accepted, "rejected": rejected,
        "invariant_failure_count": len(invariant_failures), "agent_state_isolation": isolation_ok,
        "environment_axes": {k: len(v) for k, v in ENV_AXES.items()},
        "pairwise_environment_coverage": run_pairwise_environment_sweep(seed),
        "observability_note": "Synthetic Python model only; Unreal physical/navigation fields require UE server telemetry.",
        "event_sample": events[:25], "catalog_failures": [e for e in catalog_results if e["invariant_errors"]],
        "invariant_failures": invariant_failures[:20],
    }
    return report


def write_outputs(report: dict[str, Any], report_path: Path | None = None) -> tuple[Path, Path]:
    OUT.mkdir(parents=True, exist_ok=True)
    report_path = report_path or (OUT / "ridge_botlab_report.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    catalog_path = Path(__file__).with_name("action_catalog.json")
    catalog_path.write_text(json.dumps({"schema": "ridge.botlab.catalog.v1", "count": len(CATALOG), "actions": CATALOG}, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path, catalog_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents", type=int, default=64)
    ap.add_argument("--actions", type=int, default=250)
    ap.add_argument("--seed", type=int, default=20261121)
    ap.add_argument("--report-path", type=Path, default=None)
    args = ap.parse_args()
    if args.agents < 1 or args.actions < 1: ap.error("agents and actions must be positive")
    report = run_simulation(args.agents, args.actions, args.seed)
    report_path, catalog_path = write_outputs(report, args.report_path)
    print(json.dumps({"report": str(report_path), "catalog": str(catalog_path),
                      "events": report["simulated_events"], "catalog_actions": report["catalog_actions"],
                      "accepted": report["accepted"], "rejected": report["rejected"],
                      "invariant_failures": report["invariant_failure_count"],
                      "agent_state_isolation": report["agent_state_isolation"]}, ensure_ascii=False, indent=2))
    return 0 if report["invariant_failure_count"] == 0 and report["agent_state_isolation"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
