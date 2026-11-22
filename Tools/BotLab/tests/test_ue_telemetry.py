from __future__ import annotations
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'validate_ue_telemetry.py'
SPEC = importlib.util.spec_from_file_location('ue_telemetry_validator', SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


class UETelemetryValidationTests(unittest.TestCase):
    def test_valid_finalized_route_session(self):
        events = [
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'controller_ready','route_id':'','route_state':'idle'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_started','route_id':'route-a','route_state':'moving','route_generation':1},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'waypoint_requested','route_id':'route-a','route_state':'moving','active_request_id':12},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'waypoint_reached','route_id':'route-a','route_state':'moving'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_terminal','route_id':'route-a','route_state':'completed'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'capture_finalized','route_id':'route-a','route_state':'completed'},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'movement_telemetry_session-a.jsonl'
            p.write_text('\n'.join(json.dumps(x) for x in events)+'\n',encoding='utf-8')
            report=module.validate_file(p)
        self.assertTrue(report['valid'], report['errors'])
        self.assertEqual(1,report['route_count'])
        self.assertEqual(1,report['route_outcomes']['completed'])

    def test_missing_terminal_and_capture_finalization_fail(self):
        events = [
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'controller_ready','route_id':'','route_state':'idle'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_started','route_id':'route-a','route_state':'moving','route_generation':1},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'movement_telemetry_session-a.jsonl'
            p.write_text('\n'.join(json.dumps(x) for x in events)+'\n',encoding='utf-8')
            report=module.validate_file(p)
        self.assertFalse(report['valid'])
        self.assertTrue(any(x.startswith('route_not_terminal:') for x in report['errors']))
        self.assertIn('capture_not_finalized',report['errors'])

    def test_invalid_json_line_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'movement_telemetry_session-a.jsonl'
            p.write_text('{not-json}\n',encoding='utf-8')
            report=module.validate_file(p)
        self.assertFalse(report['valid'])
        self.assertTrue(any(x.startswith('line_1_invalid_json:') for x in report['errors']))

    def test_route_generation_must_be_monotonic_and_finalization_last(self):
        events = [
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'controller_ready','route_id':'','route_state':'idle'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_started','route_id':'route-a','route_state':'moving','route_generation':1},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_terminal','route_id':'route-a','route_state':'completed'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'capture_finalized','route_id':'route-a','route_state':'completed'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'movement_sample','route_id':'route-a','route_state':'completed'},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'movement_telemetry_session-a.jsonl'
            p.write_text('\n'.join(json.dumps(x) for x in events)+'\n',encoding='utf-8')
            report=module.validate_file(p)
        self.assertFalse(report['valid'])
        self.assertIn('events_found_after_capture_finalized', report['errors'])

    def test_movement_sample_rejects_nonfinite_physics_values(self):
        events = [
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'controller_ready','route_id':'','route_state':'idle'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_started','route_id':'route-a','route_state':'moving','route_generation':1},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'movement_sample','route_id':'route-a','route_state':'moving',
             'actor_position_cm':[0, float('inf'), 0], 'actor_rotation_deg':[0,0,0], 'speed_cm_s':float('nan'),
             'movement_mode_id':1,'custom_movement_mode_id':0,'nav_path_status':'moving','nav_partial_path':False,'observability_missing_fields':[]},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'route_terminal','route_id':'route-a','route_state':'cancelled'},
            {'schema':'ridge.botlab.telemetry.v1','controller_session_id':'session-a','event':'capture_finalized','route_id':'route-a','route_state':'cancelled'},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'movement_telemetry_session-a.jsonl'
            p.write_text('\n'.join(json.dumps(x) for x in events)+'\n',encoding='utf-8')
            report=module.validate_file(p)
        self.assertFalse(report['valid'])
        self.assertIn('event_3_invalid_actor_position', report['errors'])
        self.assertIn('event_3_invalid_speed', report['errors'])


if __name__ == '__main__':
    unittest.main(verbosity=2)