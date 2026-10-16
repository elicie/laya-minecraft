"""Meaning-preserving Minecraft question variants; labels follow option semantics."""
import hashlib
import random
import re

VARIANTS = ('reverse_options', 'shuffled_options', 'renamed_keys', 'paraphrased_options',
            'paraphrased_instructions', 'multiline_state', 'spaced_state', 'combined')
DESCRIPTIONS = {
    'food_action': {
        'eat': 'Consume a safe meal already in inventory to address urgent hunger.',
        'cook': 'Prepare safe cooked food from raw ingredients already available.',
        'bread': 'Use three or more wheat to make bread.',
        'hunt': 'Get food ingredients by hunting an animal observed nearby.',
        'farm': 'Collect mature crops, or establish and tend available farmland.',
        'explore': 'Look elsewhere for food or supplies if local food routes cannot be used.',
        'wait': 'Allow crops to mature if there is no quicker way to obtain food.',
        'continue': 'Resume the main objective if enough food is stored and hunger is not urgent.',
        'stop': 'Suspend work because health is critical.',
    },
    'activity_action': {
        'food': 'Replenish food at hunger under 18 if combat conditions are safe.',
        'farm': 'Do due farm work: harvest mature crops, sow seeds, or fix the farm.',
        'wait': 'Wait until the crop check is due, or wait when no enemies are present.',
        'survey': 'Locate a construction site if a site has not been established.',
        'gather': 'Obtain lacking construction or farm materials, a gathering tool, or a weapon.',
        'build': 'Build at the established site once materials for the next step are available.',
        'collect': 'Gather the visible target resource using a serviceable tool.',
        'search': 'Look for absent resources or farmland, or find another route around blocked work.',
        'fight': 'Engage observed hostile mobs with a weapon under safe combat conditions.',
        'retreat': 'Escape dangerous combat caused by low health, multiple nearby enemies, or a nearby creeper without a bow.',
        'finish': 'Mark the objective complete only after its completion has been observed.',
        'pause': 'Suspend the mission for critical health, a full inventory, or lack of an allowed work route.',
    },
}
INSTRUCTIONS = {
    'food_action': 'Choose one supported food action using the Minecraft observations. Critical health comes first, then urgent hunger, then the food-stock target. Honor blocked actions and use only observed food and animals.',
    'activity_action': 'Choose one supported mission action using Minecraft observations. Handle dangerous combat and critical health first, then hunger, observed completion, and the current objective. Honor blocked actions and inventory capacity. Completion requires objective_done=yes.',
}
DESCRIPTIONS['base_action'] = {
    'seed_supply': 'Obtain a bounded load of missing wheat seed and bring it back to the known warehouse.',
    'wood_supply': 'Bring back a small amount of missing natural timber for the required tools.',
    'farm_setup': 'Prepare the observed irrigated soil and plant or replace crops using actual seed and tools.',
    'farm_harvest': 'Gather ripe wheat, sow replacement seed and put the harvested crop into storage.',
    'bake_food': 'Turn three available wheat into bread with the existing worktable, using warehouse ingredients when necessary, and store the bread.',
    'base_return': 'Walk back along observed safe ground and use the registered base doorway.',
    'warehouse_store': 'Put supplies already carried into shared storage and check the matching quantity changes.',
    'warehouse_take': 'Take confirmed stored supplies needed for the next allowed task.',
    'tool_craft': 'Make the missing necessary tool using observed ingredients and the existing worktable.',
    'explore': 'Search additional verified ground for the missing resource when nearby options cannot progress.',
    'shelter': 'Remain protected behind the verified closed base door until day and a clear exit.',
    'wait': 'Keep the checkpoint and await a real change in crop maturity, supplies, daylight or passage.',
}
INSTRUCTIONS['base_action'] = 'Pick the next permitted Minecraft base workflow from actual observations. Follow user priorities and permissions. Return safely before a distant dusk trip; then resolve food production prerequisites. Count only observed ingredients, stored stock and mature crops. If no allowed workflow can progress, preserve the work and wait.'


def variant(row, questions, name):
    if name not in VARIANTS:
        raise ValueError('Unknown perturbation')
    task = row['task']
    question = questions[task]
    items = list(question['criteria'].items())
    seed = int(hashlib.sha256((row['id'] + ':' + name).encode()).hexdigest()[:16], 16)
    if name == 'reverse_options':
        items.reverse()
    elif name in ('shuffled_options', 'combined'):
        random.Random(seed).shuffle(items)
        if [key for key, _ in items] == list(question['criteria']):
            items = items[1:] + items[:1]
    rename = name in ('renamed_keys', 'combined')
    paraphrase = name in ('paraphrased_options', 'combined')
    criteria = {(f'option_{i+1}' if rename else action):
                (DESCRIPTIONS[task][action] if paraphrase else description)
                for i, (action, description) in enumerate(items)}
    state = row['state']
    if name in ('multiline_state', 'combined'):
        state = state.replace('; ', ';\n')
    if name == 'spaced_state':
        state = state.replace('=', ' = ')
    transformed = {'type': 'choice', 'instructions':
                   INSTRUCTIONS[task] if name in ('paraphrased_instructions', 'combined') else question['instructions'],
                   'criteria': criteria}
    return {**row, 'id': row['id'] + ':' + name, 'original_id': row['id'], 'variant': name,
            'state': state, 'question': transformed, 'option_actions': [action for action, _ in items]}


def validate_question(task, question, trained):
    """Accept only the trained task and audited equivalent descriptions/instructions."""
    canonical = trained[task]
    if not isinstance(question, dict) or set(question) != {'type', 'instructions', 'criteria'} or question['type'] != 'choice':
        raise ValueError('Expected one Minecraft choice question')
    if question['instructions'] not in (canonical['instructions'], INSTRUCTIONS[task]):
        raise ValueError('Instructions are outside the trained Minecraft contract')
    criteria = question['criteria']
    if not isinstance(criteria, dict) or len(criteria) != len(canonical['criteria']):
        raise ValueError('All trained actions must be present')
    lookup = {}
    for action, description in canonical['criteria'].items():
        lookup[description] = action
        lookup[DESCRIPTIONS[task][action]] = action
    actions = []
    for key, description in criteria.items():
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', key):
            raise ValueError('Invalid option key')
        if not isinstance(description, str) or description not in lookup:
            raise ValueError('Option description is outside the trained Minecraft contract')
        actions.append(lookup[description])
    if set(actions) != set(canonical['criteria']):
        raise ValueError('Duplicate or missing action semantics')
    return actions
