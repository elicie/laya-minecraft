import copy
import unittest
from common import ROOT, read_json
from question_contract import CANONICAL_BASE_PROFILE, validate_request_question
from robustness import variant


class CanonicalQuestionContract(unittest.TestCase):
    def setUp(self):
        q = read_json(ROOT/'packages/contracts/src/base-decisions.json')
        self.config = {'version': 3, 'deployment_profile': CANONICAL_BASE_PROFILE, 'questions': {'base_action': q}}

    def test_canonical(self):
        validate_request_question('base_action', self.config['questions'], self.config)

    def test_variants_and_reordered_options_are_rejected(self):
        for name in ['combined', 'reverse_options', 'paraphrased_options', 'renamed_keys', 'paraphrased_instructions']:
            q = variant({'id': 'contract-test', 'task': 'base_action', 'state': 'actual observations'}, self.config['questions'], name)['question']
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_request_question('base_action', {'base_action': q}, self.config)

    def test_other_payload_and_missing_options_are_rejected(self):
        for supplied in [None, {}, {**self.config['questions'], 'another_task': {}}]:
            with self.assertRaises(ValueError):
                validate_request_question('base_action', supplied, self.config)
        supplied = copy.deepcopy(self.config['questions']); supplied['base_action']['criteria'].popitem()
        with self.assertRaises(ValueError): validate_request_question('base_action', supplied, self.config)

    def test_existing_broad_profile_keeps_its_existing_semantic_contract(self):
        config = {**self.config, 'deployment_profile': None}
        q = variant({'id': 'contract-test', 'task': 'base_action', 'state': 'actual observations'}, config['questions'], 'combined')['question']
        validate_request_question('base_action', {'base_action': q}, config)


if __name__ == '__main__': unittest.main()
