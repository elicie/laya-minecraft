import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from fleet_run_continuity import continuity_problem, expected_wait


class FleetRunContinuity(unittest.TestCase):
    def setUp(self):
        self.original = {'sessionId': 'same-client', 'world': 'infra:25565', 'dimension': 'overworld'}
        self.agent = {'id': 'builder', 'session': {'id': 'same-client', 'state': 'ready', 'lastReportAt': 99000,
                      'report': {'ready': True, 'world': 'infra:25565', 'dimension': 'overworld'}}}
        self.deaths = {'death-1': {'botId': 'builder', 'data': {'deathId': 'death-1'}}}

    def respawning(self):
        a = copy.deepcopy(self.agent)
        a['session']['report']['ready'] = False
        a['recovery'] = {'deathId': 'death-1', 'occurredAt': 99000, 'phase': 'waiting-respawn'}
        return a

    def test_ready_same_session(self):
        self.assertIsNone(continuity_problem(self.agent, self.original, 100000, {}))

    def test_confirmed_respawn_preserves_the_same_connection(self):
        self.assertIsNone(continuity_problem(self.respawning(), self.original, 100000, self.deaths))

    def test_unready_without_matching_death_is_invalid(self):
        for deaths in [{}, {'death-1': {'botId': 'another-bot'}}]:
            self.assertIsNotNone(continuity_problem(self.respawning(), self.original, 100000, deaths))

    def test_respawn_cannot_hide_a_new_session_or_disconnect(self):
        for state in ['stopped', 'abnormal', 'connecting']:
            a = self.respawning(); a['session']['state'] = state
            self.assertIsNotNone(continuity_problem(a, self.original, 100000, self.deaths))
        a = self.respawning(); a['session']['id'] = 'replacement-client'
        self.assertIsNotNone(continuity_problem(a, self.original, 100000, self.deaths))

    def test_stale_or_unbounded_respawn_is_invalid(self):
        for field, value in [('lastReportAt', 70000), ('deathAt', 60000)]:
            a = self.respawning()
            if field == 'deathAt': a['recovery']['occurredAt'] = value
            else: a['session'][field] = value
            self.assertIsNotNone(continuity_problem(a, self.original, 100000, self.deaths))

    def test_changed_world_and_dimension_remain_invalid(self):
        for field, value in [('world', 'other:25565'), ('dimension', 'the_nether')]:
            a = self.respawning(); a['session']['report'][field] = value
            self.assertIsNotNone(continuity_problem(a, self.original, 100000, self.deaths))

    def test_exposed_night_wait_is_not_a_shelter_sample(self):
        self.assertEqual(expected_wait({'action': '안전한 대피처 대기', 'isDay': False, 'timeOfDay': 15000}, [{}]), 'night-without-shelter')
        self.assertEqual(expected_wait({'action': '창고 야간 대피', 'isDay': False, 'timeOfDay': 15000}, [{}]), 'night-shelter')
        self.assertIsNone(expected_wait({'action': '창고 야간 대피', 'isDay': True, 'timeOfDay': 1000}, [{}]))


if __name__ == '__main__':
    unittest.main()
