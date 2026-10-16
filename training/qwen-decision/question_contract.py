"""Deployment scopes are explicit; semantic variants need their own qualification."""
from robustness import validate_question

CANONICAL_BASE_PROFILE = 'canonical-base-v1'


def validate_request_question(task, supplied, config):
    if config.get('deployment_profile') == CANONICAL_BASE_PROFILE and task == 'base_action':
        if not isinstance(supplied, dict) or set(supplied) != {task}:
            raise ValueError('Expected the qualified canonical base question')
        question = supplied[task]
        expected = config['questions'][task]
        if (not isinstance(question, dict) or set(question) != set(expected)
                or question.get('type') != expected['type']
                or question.get('instructions') != expected['instructions']
                or not isinstance(question.get('criteria'), dict)
                or list(question['criteria'].items()) != list(expected['criteria'].items())):
            raise ValueError('This deployment accepts only the qualified canonical base question and option order')
        return
    if config.get('version', 1) >= 3:
        if not isinstance(supplied, dict) or set(supplied) != {task}:
            raise ValueError('Expected one trained Minecraft question')
        validate_question(task, supplied[task], config['questions'])
    elif supplied != {task: config['questions'][task]}:
        raise ValueError('Action schema differs from trained checkpoint')
