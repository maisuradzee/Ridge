from __future__ import annotations
import concurrent.futures
import copy
import sys
import unittest
from pathlib import Path

BOTLAB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BOTLAB_DIR))
from interaction_contracts import InteractionContractLab, run_smoke_suite, run_randomized_stress, validate_action_bindings, _hash_state


class InteractionContractTests(unittest.TestCase):
    def test_smoke_contract_suite_passes(self):
        report = run_smoke_suite()
        self.assertTrue(report['all_passed'], report['checks_detail'])
        self.assertGreaterEqual(report['checks'], 20)

    def test_duplicate_idempotency_key_cannot_double_spend_concurrently(self):
        lab = InteractionContractLab()
        def transfer(_):
            return lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 100}, 'same-idem-key')
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(transfer, range(40)))
        self.assertEqual(1, sum(r.accepted and not r.replayed for r in results))
        self.assertEqual(39, sum(r.replayed for r in results))
        self.assertEqual(400, lab.state['wallets']['player-a'])
        self.assertEqual(200, lab.state['wallets']['player-b'])
        self.assertEqual(1, sum(1 for event in lab.audit if event['operation'] == 'economy.transfer' and event['accepted'] and not event['replayed']))
        self.assertEqual(39, sum(1 for event in lab.audit if event['operation'] == 'economy.transfer' and event['replayed']))

    def test_concurrent_transfers_never_overdraw_or_unbalance_ledger(self):
        lab = InteractionContractLab()
        def transfer(i):
            return lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 100}, f'parallel-{i}')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(transfer, range(12)))
        self.assertEqual(5, sum(r.accepted for r in results))
        self.assertEqual(0, lab.state['wallets']['player-a'])
        self.assertEqual(600, lab.state['wallets']['player-b'])
        for txid in {entry['txid'] for entry in lab.state['ledger']}:
            entries = [e for e in lab.state['ledger'] if e['txid'] == txid]
            self.assertEqual(sum(e['amount'] for e in entries if e['direction'] == 'debit'),
                             sum(e['amount'] for e in entries if e['direction'] == 'credit'))

    def test_rejected_operation_is_game_state_non_mutating(self):
        lab = InteractionContractLab()
        before = _hash_state(lab.state)
        result = lab.execute('property.enter', 'player-b', 'home-a')
        self.assertFalse(result.accepted)
        self.assertEqual(before, _hash_state(lab.state))

    def test_injected_failure_rolls_back_exact_state(self):
        lab = InteractionContractLab()
        before = copy.deepcopy(lab.state)
        result = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 80}, inject_fault_at='after_sender_debit')
        self.assertFalse(result.accepted)
        self.assertEqual(before, lab.state)


    def test_idempotency_key_reuse_with_different_payload_is_rejected(self):
        lab = InteractionContractLab()
        first = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 100}, 'key-reuse')
        before = _hash_state(lab.state)
        second = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 200}, 'key-reuse')
        self.assertTrue(first.accepted)
        self.assertFalse(second.accepted)
        self.assertEqual('idempotency_key_reused_with_different_request', second.reason)
        self.assertEqual(before, _hash_state(lab.state))

    def test_audit_sequence_is_monotonic_across_rejections_successes_and_replays(self):
        lab = InteractionContractLab()
        lab.execute('property.enter', 'player-b', 'home-a')
        lab.execute('door.unlock', 'player-a', 'front-door')
        lab.execute('door.open', 'player-a', 'front-door', {'in_range': True})
        first = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 5}, 'audit-replay')
        replay = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 5}, 'audit-replay')
        self.assertTrue(first.accepted)
        self.assertTrue(replay.replayed)
        self.assertTrue(any(event.get('replay_attempt') is True for event in lab.audit))
        sequences = [event['sequence'] for event in lab.audit]
        self.assertEqual(sorted(sequences), sequences)
        self.assertEqual(len(sequences), len(set(sequences)))

    def test_invariant_violation_forces_rollback(self):
        lab = InteractionContractLab()
        before = copy.deepcopy(lab.state)
        original = lab._assert_invariants
        def force_failure():
            raise AssertionError('fault_invariant')
        lab._assert_invariants = force_failure
        result = lab.execute('economy.transfer', 'player-a', 'player-b', {'recipient': 'player-b', 'amount': 25})
        lab._assert_invariants = original
        self.assertFalse(result.accepted)
        self.assertTrue(result.reason.startswith('invariant_violation_rolled_back:'))
        self.assertEqual(before, lab.state)


    def test_action_contracts_bind_to_catalog_intents(self):
        report = validate_action_bindings()
        self.assertTrue(report['valid'], report['missing'])
        self.assertGreaterEqual(report['binding_count'], 18)

    def test_randomized_fault_injection_stress_preserves_invariants(self):
        report = run_randomized_stress(iterations=1600, seed=9001)
        self.assertEqual(1600, report['invariant_checks'])
        self.assertTrue(report['wallet_value_conserved'])
        self.assertGreater(report['injected_fault_rollbacks'], 0)

    def test_unknown_operation_is_rejected(self):
        lab = InteractionContractLab()
        before = _hash_state(lab.state)
        result = lab.execute('unsafe.admin_override', 'player-a', 'world')
        self.assertFalse(result.accepted)
        self.assertEqual('unknown_operation', result.reason)
        self.assertEqual(before, _hash_state(lab.state))


if __name__ == '__main__':
    unittest.main(verbosity=2)
