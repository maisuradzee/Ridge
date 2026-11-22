import copy
import json
import sys
import unittest
from pathlib import Path

BOTLAB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BOTLAB_DIR))
import botlab


class BotLabTests(unittest.TestCase):
    def test_catalog_has_303_unique_intents(self):
        self.assertEqual(303, len(botlab.CATALOG))
        self.assertEqual(303, len({item['id'] for item in botlab.CATALOG}))
        self.assertEqual(28, len(botlab.FAMILIES))
        self.assertTrue(all(item['precondition_tags'] and item['observable_tags'] for item in botlab.CATALOG))
        self.assertTrue(all(item['execution_mode'] in {'state_transition_model', 'contract_probe_only'} for item in botlab.CATALOG))

    def test_each_catalog_action_has_no_state_invariant_violation_in_isolation(self):
        for index, action in enumerate(botlab.CATALOG):
            state = botlab.AgentState(agent_id=f'isolated-{index}')
            state.inventory.append('test_resource')
            env = {axis: values[0] for axis, values in botlab.ENV_AXES.items()}
            env['object_state'] = 'available'
            event = botlab.apply_action(action, state, env)
            self.assertEqual([], event['invariant_errors'], action['id'])

    def test_agent_wallets_are_isolated(self):
        a = botlab.AgentState(agent_id='a', wallet=500)
        b = botlab.AgentState(agent_id='b', wallet=500)
        action = botlab.CATALOG_BY_ID['economy.pay_invoice']
        botlab.apply_action(action, a, {})
        self.assertEqual(400, a.wallet)
        self.assertEqual(500, b.wallet)

    def test_mission_reward_is_idempotent(self):
        state = botlab.AgentState(agent_id='reward-test', mission_state='completed')
        action = botlab.CATALOG_BY_ID['missions.claim_reward']
        first = botlab.apply_action(action, state, {})
        second = botlab.apply_action(action, state, {})
        self.assertTrue(first['accepted'])
        self.assertFalse(second['accepted'])
        self.assertEqual(1100, state.wallet)

    def test_mission_transition_requires_active_state(self):
        state = botlab.AgentState(agent_id='mission-test')
        accept = botlab.apply_action(botlab.CATALOG_BY_ID['missions.accept_mission'], state, {})
        complete = botlab.apply_action(botlab.CATALOG_BY_ID['missions.complete_objective'], state, {})
        claim = botlab.apply_action(botlab.CATALOG_BY_ID['missions.claim_reward'], state, {})
        self.assertTrue(accept['accepted'])
        self.assertTrue(complete['accepted'])
        self.assertTrue(claim['accepted'])

    def test_cancelled_route_cannot_remain_moving(self):
        state = botlab.AgentState(agent_id='route-test', route_state='moving')
        event = botlab.apply_action(botlab.CATALOG_BY_ID['navigation.abandon_route'], state, {})
        self.assertTrue(event['accepted'])
        self.assertEqual('cancelled', state.route_state)
        self.assertTrue(state.route_cancelled)
        self.assertFalse(botlab.apply_action(botlab.CATALOG_BY_ID['navigation.replan_route'], state, {})['accepted'])

    def test_sprint_respects_stamina(self):
        state = botlab.AgentState(agent_id='tired', stamina=5)
        event = botlab.apply_action(botlab.CATALOG_BY_ID['locomotion.sprint'], state, {})
        self.assertFalse(event['accepted'])
        self.assertEqual(5, state.stamina)

    def test_purchase_cannot_make_wallet_negative(self):
        state = botlab.AgentState(agent_id='poor', wallet=10)
        event = botlab.apply_action(botlab.CATALOG_BY_ID['economy.buy_goods'], state, {})
        self.assertFalse(event['accepted'])
        self.assertEqual(10, state.wallet)
        self.assertEqual([], state.inventory)

    def test_pairwise_environment_coverage_is_complete(self):
        coverage = botlab.pairwise_environment_coverage()
        self.assertTrue(coverage['complete'])
        self.assertEqual(coverage['expected_pairs'], coverage['covered_pairs'])
        self.assertEqual(20, coverage['axis_count'])
        self.assertEqual(16, len(botlab.AGENT_ARCHETYPES))
        sweep = botlab.run_pairwise_environment_sweep(91)
        self.assertTrue(sweep['complete_execution'])
        self.assertEqual(sweep['expected_pairs'], sweep['scenario_executions'])

    def test_synthetic_simulation_is_reproducible_and_isolated(self):
        first = botlab.run_simulation(12, 30, 77)
        second = botlab.run_simulation(12, 30, 77)
        self.assertEqual(first['simulated_events'], 360)
        self.assertEqual(first['accepted'], second['accepted'])
        self.assertEqual(first['rejected'], second['rejected'])
        self.assertEqual(0, first['invariant_failure_count'])
        self.assertTrue(first['agent_state_isolation'])

    def test_archetypes_are_nonclinical_decision_dimensions(self):
        for agent in botlab.AGENT_ARCHETYPES:
            for key in ('risk_tolerance', 'planning_horizon', 'social_orientation', 'novelty_seeking', 'attention'):
                self.assertGreaterEqual(agent[key], 0.0)
                self.assertLessEqual(agent[key], 1.0)
            self.assertNotIn('diagnosis', agent)

    def test_ue_adapter_records_cancel_and_null_observability(self):
        header = (BOTLAB_DIR.parents[1] / 'Source/RIDGE/Public/RidgeBotTestController.h').read_text()
        source = (BOTLAB_DIR.parents[1] / 'Source/RIDGE/Private/RidgeBotTestController.cpp').read_text()
        self.assertIn('CancelTestRoute', header)
        self.assertIn('MarkRouteTerminal(TEXT("cancelled")', source)
        self.assertIn('navigation_stall_detected', source)
        self.assertIn('FinalizeTelemetryCapture', header)
        self.assertIn('movement_telemetry_%s.jsonl', source)
        self.assertIn('observability_missing_fields', source)
        self.assertIn('stale_move_completion_ignored', source)
        self.assertIn('RequestID.GetID() != ActiveRequestId.GetID()', source)
        self.assertIn('FAIMoveRequest MoveRequest', source)
        self.assertIn('const FPathFollowingRequestResult RequestResult = MoveTo', source)
        self.assertNotIn('const FPathFollowingRequestResult RequestResult = MoveToLocation', source)
        self.assertIn('FJsonValueNull', source)
        self.assertIn('HandlePawnHit', source)
        self.assertIn('pawn_collision', source)
        self.assertIn('collision_impact_point_cm', source)
        self.assertIn('collision_physical_material', source)
        self.assertIn('controller_session_id', source)
        self.assertIn('route_generation', source)
        self.assertIn('capture_finalized', source)
        self.assertIn('GetID() != ActiveRequestId.GetID()', source)
        self.assertIn('FMath::IsFinite(Waypoint.X)', source)
        self.assertIn('FMath::IsFinite(Waypoint.Y)', source)
        self.assertIn('FMath::IsFinite(Waypoint.Z)', source)
        self.assertIn('while (Waypoints.IsValidIndex(WaypointIndex))', source)
        self.assertNotIn('Hit->GetActor()->GetName()', source)
        self.assertIn('nav_partial_path', source)
        self.assertIn('movement_sample', source)
        self.assertIn('distance_to_waypoint_cm', source)
        self.assertIn('InWaypoints.Num() > 256', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
