#!/usr/bin/env python3
"""Transactional gameplay interaction contracts for RIDGE BotLab.

This isolated QA model never connects to a production DB or player accounts.
It exercises authorization, ownership, capacity, idempotency, atomic rollback,
and cross-system invariants before the matching Unreal gameplay systems exist.
"""
from __future__ import annotations

import copy
import hashlib
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from botlab import CATALOG_BY_ID


class ContractRejected(Exception):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


class InjectedFault(Exception):
    pass


OPERATION_ACTION_BINDINGS = {
    "door.unlock": "interaction.unlock_door",
    "door.open": "interaction.open_door",
    "door.close": "interaction.close_door",
    "door.lock": "interaction.lock_door",
    "property.unlock": "property.unlock_property",
    "property.enter": "property.enter_property",
    "inventory.consume": "inventory.consume_item",
    "inventory.transfer": "inventory.transfer_item",
    "economy.transfer": "economy.transfer_money",
    "mission.claim_reward": "missions.claim_reward",
    "vehicle.enter": "vehicles.enter_vehicle",
    "vehicle.exit": "vehicles.exit_vehicle",
    "transport.board": "transport.board_bus",
    "transport.exit": "transport.exit_bus",
    "social.assist": "social.offer_help",
    "utility.restore": "utilities.restore_service",
    "animal.feed": "animals.feed_animal",
    "crafting.make": "crafting.craft_item",
}


def validate_action_bindings() -> dict[str, Any]:
    missing = {op: action for op, action in OPERATION_ACTION_BINDINGS.items() if action not in CATALOG_BY_ID}
    return {"binding_count": len(OPERATION_ACTION_BINDINGS), "missing": missing, "valid": not missing}


@dataclass
class OperationResult:
    accepted: bool
    reason: str
    operation: str
    transaction_id: str | None = None
    replayed: bool = False
    state_hash_before: str = ""
    state_hash_after: str = ""

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _hash_state(state: dict[str, Any]) -> str:
    raw = json.dumps(state, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class InteractionContractLab:
    """Thread-safe, rollback-capable test world with isolated synthetic accounts."""

    def __init__(self) -> None:
        self.state: dict[str, Any] = {
            "wallets": {"player-a": 500, "player-b": 100, "REWARD_POOL": 10000},
            "inventories": {
                "player-a": {"front-door-key": 1, "apple": 3, "wood": 4, "metal": 2, "medkit": 1},
                "player-b": {"apple": 1},
            },
            "inventory_capacity": {"player-a": 20, "player-b": 20},
            "doors": {"front-door": {"owner": "player-a", "locked": True, "open": False, "key_item": "front-door-key"}},
            "properties": {"home-a": {"owner": "player-a", "tenants": [], "access_list": ["player-a"], "locked": True}},
            "missions": {"delivery-1": {"owner": "player-a", "status": "completed", "reward": 75, "claimed": False}},
            "vehicles": {"car-1": {"owner": "player-a", "allowed": ["player-a", "player-b"], "seats": {"driver": None, "passenger": None}}},
            "actor_vehicle": {"player-a": None, "player-b": None},
            "social_requests": {"assist-1": {"target": "player-b", "active": True, "consent": False}},
            "utilities": {"power-a": {"status": "offline", "technician": "player-a"}},
            "animals": {"pet-a": {"owner": "player-a", "hunger": 80, "food": 2, "welfare_ok": True}},
            "transport": {"bus-1": {"capacity": 1, "occupants": [], "ticket_holders": ["player-a"], "boarding_open": True}},
            "actor_transport": {"player-a": None, "player-b": None},
            "recipes": {"basic-tool": {"inputs": {"wood": 2, "metal": 1}, "output": "basic-tool", "station_online": True}},
            "ledger": [],
            "idempotency": {},
            "transaction_sequence": 0,
        }
        self.audit: list[dict[str, Any]] = []
        self._audit_sequence = 0
        self._initial_wallet_total = sum(self.state["wallets"].values())
        self._lock = threading.RLock()

    def execute(self, operation: str, actor: str, target: str, payload: dict[str, Any] | None = None,
                idempotency_key: str | None = None, inject_fault_at: str | None = None) -> OperationResult:
        payload = payload or {}
        with self._lock:
            before = _hash_state(self.state)
            if idempotency_key is not None and (not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 128):
                self._audit_sequence += 1
                invalid_key = OperationResult(False, "invalid_idempotency_key", operation, None, False, before, before)
                self.audit.append({"sequence": self._audit_sequence, **invalid_key.as_dict(), "actor": actor, "target": target})
                return invalid_key
            request_fingerprint = hashlib.sha256(json.dumps(
                {"operation": operation, "actor": actor, "target": target, "payload": payload},
                sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
            ).encode("utf-8")).hexdigest()
            if idempotency_key:
                cached = self.state["idempotency"].get(idempotency_key)
                if cached:
                    if cached["fingerprint"] != request_fingerprint:
                        self._audit_sequence += 1
                        conflict = OperationResult(False, "idempotency_key_reused_with_different_request", operation,
                                                   None, False, before, before)
                        self.audit.append({"sequence": self._audit_sequence, **conflict.as_dict(), "actor": actor, "target": target})
                        return conflict
                    replay = OperationResult(**cached["result"])
                    replay.replayed = True
                    self._audit_sequence += 1
                    self.audit.append({"sequence": self._audit_sequence, **replay.as_dict(),
                                       "actor": actor, "target": target, "replay_attempt": True})
                    return replay

            snapshot = copy.deepcopy(self.state)
            transaction_id = f"tx-{self.state['transaction_sequence'] + 1:08d}"
            try:
                self._apply(operation, actor, target, payload, transaction_id, inject_fault_at)
                self._assert_invariants()
                self.state["transaction_sequence"] += 1
                after = _hash_state(self.state)
                result = OperationResult(True, "accepted", operation, transaction_id, False, before, after)
                if idempotency_key:
                    self.state["idempotency"][idempotency_key] = {
                        "fingerprint": request_fingerprint, "result": result.as_dict()
                    }
                self._audit_sequence += 1
                self.audit.append({"sequence": self._audit_sequence, **result.as_dict(), "actor": actor, "target": target})
                return result
            except ContractRejected as exc:
                self.state = snapshot
                self._audit_sequence += 1
                result = OperationResult(False, exc.reason, operation, None, False, before, _hash_state(self.state))
                self.audit.append({"sequence": self._audit_sequence, **result.as_dict(), "actor": actor, "target": target})
                return result
            except InjectedFault:
                self.state = snapshot
                self._audit_sequence += 1
                result = OperationResult(False, "injected_fault_rolled_back", operation, None, False, before, _hash_state(self.state))
                self.audit.append({"sequence": self._audit_sequence, **result.as_dict(), "actor": actor, "target": target})
                return result
            except AssertionError as exc:
                self.state = snapshot
                self._audit_sequence += 1
                result = OperationResult(False, f"invariant_violation_rolled_back:{exc}", operation, None, False, before, _hash_state(self.state))
                self.audit.append({"sequence": self._audit_sequence, **result.as_dict(), "actor": actor, "target": target})
                return result
            except Exception as exc:
                self.state = snapshot
                self._audit_sequence += 1
                result = OperationResult(False, f"internal_error_rolled_back:{type(exc).__name__}", operation, None, False, before, _hash_state(self.state))
                self.audit.append({"sequence": self._audit_sequence, **result.as_dict(), "actor": actor, "target": target})
                return result

    def _fault(self, configured: str | None, point: str) -> None:
        if configured == point:
            raise InjectedFault(point)

    def _apply(self, op: str, actor: str, target: str, p: dict[str, Any], txid: str, fault: str | None) -> None:
        if actor == "REWARD_POOL":
            raise ContractRejected("system_account_cannot_act_as_player")
        if actor not in self.state["wallets"] and actor not in self.state["inventories"]:
            raise ContractRejected("unknown_actor")

        if op == "door.unlock":
            door = self.state["doors"].get(target)
            if not door: raise ContractRejected("door_not_found")
            has_key = self.state["inventories"].get(actor, {}).get(door["key_item"], 0) > 0
            if actor != door["owner"] and not has_key: raise ContractRejected("key_or_owner_required")
            door["locked"] = False
            return

        if op == "door.open":
            door = self.state["doors"].get(target)
            if not door: raise ContractRejected("door_not_found")
            if door["locked"]: raise ContractRejected("door_locked")
            if not p.get("in_range", False): raise ContractRejected("interaction_out_of_range")
            door["open"] = True
            return

        if op == "door.close":
            door = self.state["doors"].get(target)
            if not door: raise ContractRejected("door_not_found")
            if not p.get("in_range", False): raise ContractRejected("interaction_out_of_range")
            if not door["open"]: raise ContractRejected("door_already_closed")
            door["open"] = False
            return

        if op == "door.lock":
            door = self.state["doors"].get(target)
            if not door: raise ContractRejected("door_not_found")
            if door["open"]: raise ContractRejected("close_door_before_locking")
            has_key = self.state["inventories"].get(actor, {}).get(door["key_item"], 0) > 0
            if actor != door["owner"] and not has_key: raise ContractRejected("key_or_owner_required")
            door["locked"] = True
            return

        if op == "property.unlock":
            prop = self.state["properties"].get(target)
            if not prop: raise ContractRejected("property_not_found")
            if actor != prop["owner"] and actor not in prop["tenants"]: raise ContractRejected("property_unlock_denied")
            prop["locked"] = False
            return

        if op == "property.enter":
            prop = self.state["properties"].get(target)
            if not prop: raise ContractRejected("property_not_found")
            allowed = actor == prop["owner"] or actor in prop["tenants"] or actor in prop["access_list"]
            if prop["locked"] or not allowed: raise ContractRejected("property_access_denied")
            return

        if op == "inventory.consume":
            item = p.get("item")
            amount = p.get("amount", 1)
            if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0: raise ContractRejected("invalid_quantity")
            inventory = self.state["inventories"].get(actor, {})
            if inventory.get(item, 0) < amount: raise ContractRejected("insufficient_item_quantity")
            inventory[item] -= amount
            if inventory[item] == 0: del inventory[item]
            return

        if op == "inventory.transfer":
            if actor not in self.state["inventories"]:
                raise ContractRejected("actor_inventory_unavailable")
            recipient = p.get("recipient")
            item = p.get("item")
            amount = p.get("amount")
            if recipient not in self.state["inventories"] or recipient == actor: raise ContractRejected("invalid_recipient")
            if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0: raise ContractRejected("invalid_quantity")
            source = self.state["inventories"][actor]
            destination = self.state["inventories"][recipient]
            if source.get(item, 0) < amount: raise ContractRejected("insufficient_item_quantity")
            weight = sum(destination.values()) + amount
            if weight > self.state["inventory_capacity"][recipient]: raise ContractRejected("recipient_capacity_exceeded")
            source[item] -= amount
            if source[item] == 0: del source[item]
            self._fault(fault, "after_source_debit")
            destination[item] = destination.get(item, 0) + amount
            return

        if op == "economy.transfer":
            recipient = p.get("recipient")
            amount = p.get("amount")
            if recipient not in self.state["wallets"] or recipient == actor or recipient == "REWARD_POOL": raise ContractRejected("invalid_recipient")
            if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0: raise ContractRejected("invalid_amount")
            if self.state["wallets"].get(actor, 0) < amount: raise ContractRejected("insufficient_funds")
            self.state["wallets"][actor] -= amount
            self._fault(fault, "after_sender_debit")
            self.state["wallets"][recipient] += amount
            self.state["ledger"].append({"txid": txid, "account": actor, "direction": "debit", "amount": amount})
            self.state["ledger"].append({"txid": txid, "account": recipient, "direction": "credit", "amount": amount})
            return

        if op == "mission.claim_reward":
            mission = self.state["missions"].get(target)
            if mission is None:
                raise ContractRejected("mission_not_found")
            if "owner" in mission and actor != mission["owner"]: raise ContractRejected("mission_not_owned")
            if mission["status"] != "completed": raise ContractRejected("mission_not_completed")
            if mission["claimed"]: raise ContractRejected("reward_already_claimed")
            amount = mission["reward"]
            if self.state["wallets"]["REWARD_POOL"] < amount: raise ContractRejected("reward_pool_insufficient")
            self.state["wallets"]["REWARD_POOL"] -= amount
            self._fault(fault, "after_reward_pool_debit")
            self.state["wallets"][actor] += amount
            mission["claimed"] = True
            self.state["ledger"].extend([
                {"txid": txid, "account": "REWARD_POOL", "direction": "debit", "amount": amount},
                {"txid": txid, "account": actor, "direction": "credit", "amount": amount},
            ])
            return

        if op == "vehicle.enter":
            vehicle = self.state["vehicles"].get(target)
            if not vehicle: raise ContractRejected("vehicle_not_found")
            if actor not in vehicle["allowed"]: raise ContractRejected("vehicle_access_denied")
            if self.state["actor_vehicle"].get(actor) is not None: raise ContractRejected("actor_already_in_vehicle")
            if self.state["actor_transport"].get(actor) is not None: raise ContractRejected("actor_already_on_transport")
            seat = p.get("seat")
            if seat not in vehicle["seats"]: raise ContractRejected("invalid_seat")
            if vehicle["seats"][seat] is not None: raise ContractRejected("seat_occupied")
            vehicle["seats"][seat] = actor
            self.state["actor_vehicle"][actor] = target
            return

        if op == "vehicle.exit":
            vehicle_id = self.state["actor_vehicle"].get(actor)
            if not vehicle_id: raise ContractRejected("actor_not_in_vehicle")
            if target != vehicle_id: raise ContractRejected("vehicle_target_mismatch")
            vehicle = self.state["vehicles"][vehicle_id]
            for seat, occupant in vehicle["seats"].items():
                if occupant == actor: vehicle["seats"][seat] = None
            self.state["actor_vehicle"][actor] = None
            return

        if op == "transport.board":
            vehicle = self.state["transport"].get(target)
            if not vehicle: raise ContractRejected("transport_not_found")
            if not vehicle["boarding_open"]: raise ContractRejected("boarding_closed")
            if actor not in vehicle["ticket_holders"]: raise ContractRejected("valid_ticket_required")
            if self.state["actor_transport"].get(actor) is not None: raise ContractRejected("actor_already_on_transport")
            if self.state["actor_vehicle"].get(actor) is not None: raise ContractRejected("actor_already_in_vehicle")
            if len(vehicle["occupants"]) >= vehicle["capacity"]: raise ContractRejected("transport_capacity_exceeded")
            vehicle["occupants"].append(actor)
            self.state["actor_transport"][actor] = target
            return

        if op == "transport.exit":
            transport_id = self.state["actor_transport"].get(actor)
            if not transport_id: raise ContractRejected("actor_not_on_transport")
            if target != transport_id: raise ContractRejected("transport_target_mismatch")
            vehicle = self.state["transport"][transport_id]
            vehicle["occupants"].remove(actor)
            self.state["actor_transport"][actor] = None
            return

        if op == "social.assist":
            request = self.state["social_requests"].get(target)
            if not request or not request["active"]: raise ContractRejected("request_not_active")
            if request["target"] == actor: raise ContractRejected("self_assistance_not_allowed")
            if not request["consent"]: raise ContractRejected("consent_required")
            if not p.get("in_range", False): raise ContractRejected("target_out_of_range")
            request["active"] = False
            return

        if op == "utility.restore":
            service = self.state["utilities"].get(target)
            if not service: raise ContractRejected("service_not_found")
            if service["technician"] != actor: raise ContractRejected("technician_authorization_required")
            if service["status"] == "online": raise ContractRejected("service_already_online")
            service["status"] = "online"
            return

        if op == "animal.feed":
            animal = self.state["animals"].get(target)
            if not animal: raise ContractRejected("animal_not_found")
            if animal["owner"] != actor: raise ContractRejected("animal_care_authorization_required")
            if not animal["welfare_ok"]: raise ContractRejected("animal_requires_welfare_assessment")
            if animal["food"] <= 0: raise ContractRejected("animal_food_unavailable")
            if animal["hunger"] <= 0: raise ContractRejected("animal_not_hungry")
            animal["food"] -= 1
            animal["hunger"] = max(0, animal["hunger"] - 25)
            return

        if op == "crafting.make":
            recipe = self.state["recipes"].get(target)
            if not recipe: raise ContractRejected("recipe_not_found")
            if not recipe["station_online"]: raise ContractRejected("crafting_station_offline")
            if actor not in self.state["inventories"]:
                raise ContractRejected("actor_inventory_unavailable")
            inventory = self.state["inventories"][actor]
            for item, quantity in recipe["inputs"].items():
                if inventory.get(item, 0) < quantity: raise ContractRejected("crafting_inputs_missing")
            projected_count = sum(inventory.values()) - sum(recipe["inputs"].values()) + 1
            if projected_count > self.state["inventory_capacity"][actor]: raise ContractRejected("inventory_capacity_exceeded")
            for item, quantity in recipe["inputs"].items():
                inventory[item] -= quantity
                if inventory[item] == 0: del inventory[item]
            self._fault(fault, "after_crafting_input_debit")
            inventory[recipe["output"]] = inventory.get(recipe["output"], 0) + 1
            return

        raise ContractRejected("unknown_operation")

    def _assert_invariants(self) -> None:
        for actor, balance in self.state["wallets"].items():
            if balance < 0: raise AssertionError(f"negative_wallet:{actor}")
        if sum(self.state["wallets"].values()) != self._initial_wallet_total:
            raise AssertionError("wallet_value_not_conserved")
        for txid in {entry["txid"] for entry in self.state["ledger"]}:
            entries = [e for e in self.state["ledger"] if e["txid"] == txid]
            debits = sum(e["amount"] for e in entries if e["direction"] == "debit")
            credits = sum(e["amount"] for e in entries if e["direction"] == "credit")
            if debits != credits: raise AssertionError(f"unbalanced_ledger:{txid}")
        for actor, vehicle_id in self.state["actor_vehicle"].items():
            if vehicle_id:
                vehicle = self.state["vehicles"][vehicle_id]
                if sum(seat == actor for seat in vehicle["seats"].values()) != 1:
                    raise AssertionError(f"vehicle_occupancy_mismatch:{actor}")
        for vehicle_id, vehicle in self.state["vehicles"].items():
            occupied = [actor for actor in vehicle["seats"].values() if actor]
            if len(occupied) != len(set(occupied)): raise AssertionError(f"duplicate_vehicle_occupant:{vehicle_id}")
            for actor in occupied:
                if self.state["actor_vehicle"].get(actor) != vehicle_id:
                    raise AssertionError(f"vehicle_reverse_index_mismatch:{actor}")
        for actor, inventory in self.state["inventories"].items():
            if any(not isinstance(v, int) or v < 0 for v in inventory.values()):
                raise AssertionError("invalid_inventory_quantity")
            if sum(inventory.values()) > self.state["inventory_capacity"][actor]:
                raise AssertionError(f"inventory_capacity_exceeded:{actor}")
        for mission in self.state["missions"].values():
            if mission["claimed"] and mission["status"] != "completed":
                raise AssertionError("reward_claimed_before_completion")
        for actor, transport_id in self.state["actor_transport"].items():
            if transport_id:
                transport = self.state["transport"][transport_id]
                if transport["occupants"].count(actor) != 1:
                    raise AssertionError(f"transport_occupancy_mismatch:{actor}")
                if self.state["actor_vehicle"].get(actor) is not None:
                    raise AssertionError(f"actor_in_vehicle_and_transport:{actor}")
        for transport_id, transport in self.state["transport"].items():
            if len(transport["occupants"]) > transport["capacity"]:
                raise AssertionError(f"transport_over_capacity:{transport_id}")
            if len(transport["occupants"]) != len(set(transport["occupants"])):
                raise AssertionError(f"duplicate_transport_occupant:{transport_id}")


def run_randomized_stress(iterations: int = 1200, seed: int = 140022) -> dict[str, Any]:
    import random
    rng = random.Random(seed)
    lab = InteractionContractLab()
    actions = [
        ("economy.transfer", "player-a", "player-b", lambda: {"recipient": "player-b", "amount": rng.randint(1, 700)}),
        ("economy.transfer", "player-b", "player-a", lambda: {"recipient": "player-a", "amount": rng.randint(1, 250)}),
        ("inventory.transfer", "player-a", "player-a", lambda: {"recipient": "player-b", "item": rng.choice(["apple", "medkit", "wood"]), "amount": rng.randint(1, 3)}),
        ("inventory.consume", "player-a", "apple", lambda: {"item": "apple", "amount": rng.randint(1, 3)}),
        ("door.unlock", "player-a", "front-door", lambda: {}),
        ("door.open", "player-a", "front-door", lambda: {"in_range": rng.choice([True, False])}),
        ("door.close", "player-a", "front-door", lambda: {"in_range": rng.choice([True, False])}),
        ("door.lock", "player-a", "front-door", lambda: {}),
        ("property.unlock", "player-a", "home-a", lambda: {}),
        ("property.enter", "player-b", "home-a", lambda: {}),
        ("mission.claim_reward", "player-a", "delivery-1", lambda: {}),
        ("vehicle.enter", "player-b", "car-1", lambda: {"seat": rng.choice(["driver", "passenger", "roof"])}),
        ("vehicle.exit", "player-b", "car-1", lambda: {}),
        ("transport.board", "player-a", "bus-1", lambda: {}),
        ("transport.exit", "player-a", "bus-1", lambda: {}),
        ("social.assist", "player-a", "assist-1", lambda: {"in_range": rng.choice([True, False])}),
        ("utility.restore", "player-a", "power-a", lambda: {}),
        ("animal.feed", "player-a", "pet-a", lambda: {}),
        ("crafting.make", "player-a", "basic-tool", lambda: {}),
    ]
    accepted = rejected = injected_faults = invariant_checks = 0
    for i in range(iterations):
        if i % 113 == 0:
            # Replenish a synthetic QA token, then force a failure after source debit.
            # The transaction wrapper must restore the exact before-state.
            lab.state["inventories"]["player-a"]["stress-token"] = 1
            result = lab.execute("inventory.transfer", "player-a", "player-a",
                                 {"recipient": "player-b", "item": "stress-token", "amount": 1},
                                 f"stress-fault-{i:06d}", "after_source_debit")
        else:
            operation, actor, target, payload_factory = rng.choice(actions)
            # Deterministic unique keys exercise idempotency without cross-request collisions.
            result = lab.execute(operation, actor, target, payload_factory(), f"stress-{i:06d}")
        accepted += int(result.accepted)
        rejected += int(not result.accepted)
        injected_faults += int(result.reason == "injected_fault_rolled_back")
        lab._assert_invariants()
        invariant_checks += 1
    return {"seed": seed, "iterations": iterations, "accepted": accepted, "rejected": rejected,
            "injected_fault_rollbacks": injected_faults, "invariant_checks": invariant_checks,
            "wallet_value_conserved": sum(lab.state["wallets"].values()) == lab._initial_wallet_total,
            "ledger_entries": len(lab.state["ledger"]), "audit_events": len(lab.audit)}


def run_smoke_suite() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    def check(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    lab = InteractionContractLab()
    before = _hash_state(lab.state)
    r = lab.execute("door.open", "player-a", "front-door", {"in_range": True})
    check("locked_door_rejected_without_mutation", not r.accepted and r.reason == "door_locked" and _hash_state(lab.state) == before, r.reason)
    r = lab.execute("door.unlock", "player-a", "front-door")
    check("door_unlock_authorized", r.accepted and not lab.state["doors"]["front-door"]["locked"], r.reason)
    r = lab.execute("door.open", "player-a", "front-door", {"in_range": False})
    check("door_out_of_range_rejected", not r.accepted and r.reason == "interaction_out_of_range", r.reason)
    r = lab.execute("property.enter", "player-b", "home-a")
    check("unauthorized_property_entry_rejected", not r.accepted and r.reason == "property_access_denied", r.reason)
    r = lab.execute("inventory.transfer", "player-a", "player-a", {"recipient": "player-b", "item": "apple", "amount": 1}, "item-transfer-1")
    check("item_transfer_atomic", r.accepted and lab.state["inventories"]["player-b"]["apple"] == 2, r.reason)
    replay = lab.execute("inventory.transfer", "player-a", "player-a", {"recipient": "player-b", "item": "apple", "amount": 1}, "item-transfer-1")
    check("item_transfer_idempotent", replay.accepted and replay.replayed and lab.state["inventories"]["player-b"]["apple"] == 2, "duplicate replay did not transfer again")
    pre = _hash_state(lab.state)
    r = lab.execute("inventory.transfer", "player-a", "player-a", {"recipient": "player-b", "item": "apple", "amount": 1}, inject_fault_at="after_source_debit")
    check("inventory_mid_operation_rollback", not r.accepted and _hash_state(lab.state) == pre, r.reason)
    r = lab.execute("economy.transfer", "player-a", "player-b", {"recipient": "player-b", "amount": 150}, "wallet-transfer-1")
    check("double_entry_wallet_transfer", r.accepted and lab.state["wallets"]["player-a"] == 350 and lab.state["wallets"]["player-b"] == 250, r.reason)
    replay = lab.execute("economy.transfer", "player-a", "player-b", {"recipient": "player-b", "amount": 150}, "wallet-transfer-1")
    check("wallet_transfer_idempotent", replay.replayed and lab.state["wallets"]["player-b"] == 250, "duplicate transfer did not double-credit")
    r = lab.execute("mission.claim_reward", "player-a", "delivery-1", {}, "mission-reward-1")
    check("mission_reward_claim", r.accepted and lab.state["wallets"]["player-a"] == 425, r.reason)
    replay = lab.execute("mission.claim_reward", "player-a", "delivery-1", {}, "mission-reward-1")
    check("mission_reward_idempotent", replay.replayed and lab.state["wallets"]["player-a"] == 425, "duplicate reward not paid again")
    r = lab.execute("vehicle.enter", "player-b", "car-1", {"seat": "passenger"})
    check("vehicle_occupancy_bijective", r.accepted and lab.state["actor_vehicle"]["player-b"] == "car-1", r.reason)
    r = lab.execute("vehicle.exit", "player-b", "car-1")
    check("vehicle_exit_releases_seat", r.accepted and lab.state["actor_vehicle"]["player-b"] is None, r.reason)
    r = lab.execute("social.assist", "player-a", "assist-1", {"in_range": True})
    check("social_assist_requires_consent", not r.accepted and r.reason == "consent_required", r.reason)
    lab.state["social_requests"]["assist-1"]["consent"] = True
    r = lab.execute("social.assist", "player-a", "assist-1", {"in_range": False})
    check("social_assist_requires_proximity", not r.accepted and r.reason == "target_out_of_range", r.reason)
    r = lab.execute("social.assist", "player-a", "assist-1", {"in_range": True})
    check("social_assist_with_consent", r.accepted and not lab.state["social_requests"]["assist-1"]["active"], r.reason)
    r = lab.execute("utility.restore", "player-b", "power-a")
    check("utility_restore_requires_authority", not r.accepted and r.reason == "technician_authorization_required", r.reason)
    r = lab.execute("utility.restore", "player-a", "power-a")
    check("utility_authorized_restore", r.accepted and lab.state["utilities"]["power-a"]["status"] == "online", r.reason)
    r = lab.execute("animal.feed", "player-b", "pet-a")
    check("animal_care_requires_owner", not r.accepted and r.reason == "animal_care_authorization_required", r.reason)
    r = lab.execute("animal.feed", "player-a", "pet-a")
    check("animal_welfare_safe_feed", r.accepted and lab.state["animals"]["pet-a"]["hunger"] == 55, r.reason)
    before = _hash_state(lab.state)
    r = lab.execute("crafting.make", "player-a", "basic-tool", {}, inject_fault_at="after_crafting_input_debit")
    check("crafting_partial_failure_rolls_back", not r.accepted and _hash_state(lab.state) == before, r.reason)
    r = lab.execute("crafting.make", "player-a", "basic-tool")
    check("crafting_success_atomic", r.accepted and lab.state["inventories"]["player-a"].get("basic-tool") == 1, r.reason)

    r = lab.execute("door.open", "player-a", "front-door", {"in_range": True})
    check("door_open_authorized_after_unlock", r.accepted and lab.state["doors"]["front-door"]["open"], r.reason)
    r = lab.execute("door.close", "player-a", "front-door", {"in_range": True})
    check("door_close_success", r.accepted and not lab.state["doors"]["front-door"]["open"], r.reason)
    r = lab.execute("door.lock", "player-a", "front-door")
    check("door_lock_after_close", r.accepted and lab.state["doors"]["front-door"]["locked"], r.reason)
    # A property owner may unlock their own property, but an unrelated visitor may not.
    r = lab.execute("property.unlock", "player-b", "home-a")
    check("property_unlock_requires_owner_or_tenant", not r.accepted, r.reason)
    r = lab.execute("property.unlock", "player-a", "home-a")
    check("property_owner_unlocks_home", r.accepted and not lab.state["properties"]["home-a"]["locked"], r.reason)
    r = lab.execute("property.enter", "player-a", "home-a")
    check("owner_enters_unlocked_property", r.accepted, r.reason)
    r = lab.execute("inventory.consume", "player-a", "apple", {"item": "apple", "amount": 1})
    check("item_consumption_updates_inventory", r.accepted and lab.state["inventories"]["player-a"]["apple"] == 1, r.reason)
    r = lab.execute("inventory.consume", "player-b", "rare-item", {"item": "rare-item", "amount": 1})
    check("missing_item_consumption_rejected", not r.accepted and r.reason == "insufficient_item_quantity", r.reason)
    r = lab.execute("transport.board", "player-b", "bus-1")
    check("transport_requires_valid_ticket", not r.accepted and r.reason == "valid_ticket_required", r.reason)
    r = lab.execute("transport.board", "player-a", "bus-1")
    check("transport_boarding_tracks_occupancy", r.accepted and lab.state["actor_transport"]["player-a"] == "bus-1", r.reason)
    r = lab.execute("transport.exit", "player-a", "bus-1")
    check("transport_exit_releases_capacity", r.accepted and lab.state["actor_transport"]["player-a"] is None, r.reason)

    binding_report = validate_action_bindings()
    check("every_interaction_contract_maps_to_catalog_action", binding_report["valid"], json.dumps(binding_report["missing"], sort_keys=True))
    stress = run_randomized_stress()
    check("randomized_1200_step_fault_injection_stress", stress["wallet_value_conserved"] and stress["invariant_checks"] == stress["iterations"],
          f"{stress['accepted']} accepted / {stress['rejected']} rejected; {stress['injected_fault_rollbacks']} injected rollbacks")
    return {"schema": "ridge.botlab.interaction-contracts.v1", "checks": len(checks),
            "passed": sum(x["passed"] for x in checks), "failed": sum(not x["passed"] for x in checks),
            "all_passed": all(x["passed"] for x in checks), "checks_detail": checks,
            "action_bindings": binding_report, "randomized_stress": stress,
            "scope_note": "Synthetic isolated contract world only; this is not proof that matching Unreal gameplay systems are implemented."}


def main() -> int:
    report = run_smoke_suite()
    out = Path(__file__).resolve().parents[2] / "RIDGE_GIS" / "Data" / "QA" / "ridge_interaction_contract_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "checks_detail"} | {"report": str(out)}, ensure_ascii=False, indent=2))
    return 0 if report["all_passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())