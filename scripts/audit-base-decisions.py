"""Join real choices to execution outcomes without inventing training labels."""
import argparse
import collections
import json
import pathlib
import sqlite3
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--after', type=int, required=True)
args = parser.parse_args()
with sqlite3.connect(f'file:{ROOT}/runtime/control.sqlite?mode=ro', uri=True) as db:
    db.execute('BEGIN')
    snapshot = json.loads(db.execute("select value from state where key='checkpoint'").fetchone()[0])
    events = [json.loads(p) for p, in db.execute(
        'select payload from events where time>=? order by seq', (args.after,))]
attempts = {a['id']: a for a in snapshot['attempts']}
tasks = {t['id']: t for t in snapshot['tasks']}
# Attempts roll out of the checkpoint; the durable journal retains their actual
# terminal messages. Keep the evidence source explicit instead of dropping them.
terminal_types = {'task.completed': 'completed', 'task.condition-wait': 'condition-wait',
                  'task.failed': 'failed', 'task.interrupted': 'interrupted',
                  'task.cancelled': 'cancelled', 'task.held': 'held'}
terminal_events = {}
for event in events:
    if event['type'] in terminal_types and event.get('attemptId'):
        terminal_events[event['attemptId']] = event
choices, violations, execution_issues, fallback = [], [], [], []
for e in events:
    if e['type'] != 'scheduler.decision':
        continue
    data = e.get('data', {})
    candidates = data.get('observation', {}).get('candidates', [])
    selected = next((c for c in candidates if c['id'] == data.get('selectedTaskId', e.get('taskId'))), None)
    a = attempts.get(e.get('attemptId'), {})
    terminal = terminal_events.get(e.get('attemptId'), {})
    result = a.get('result', {})
    if not result and terminal:
        result = {'outcome': terminal_types[terminal['type']], 'reason': terminal.get('message')}
    row = {'eventId': e['id'], 'time': e['time'], 'source': data.get('source'),
           'model': data.get('model'), 'attemptId': e.get('attemptId'), 'taskId': e.get('taskId'),
           'taskKind': tasks.get(e.get('taskId'), {}).get('kind'),
           'selectedAction': selected.get('action') if selected else None,
           'candidateCount': len(candidates), 'distinctActionCount': len({c.get('action') for c in candidates}),
           'attemptState': a.get('state', 'not-retained'), 'executionOutcome': result.get('outcome'),
           'executionEvidence': 'attempt-result' if a.get('result') else 'durable-event' if terminal else None,
           'executionEventId': terminal.get('id'),
           'executionReason': result.get('reason'), 'expectedAction': None, 'reviewed': False}
    choices.append(row)
    if data.get('source') == 'laya' and (selected is None or selected.get('priority', 0) != max((c.get('priority', 0) for c in candidates), default=0)):
        violations.append(row)
    if data.get('source') != 'laya' and any(word in e.get('message', '') for word in ['fetch', 'timeout', 'busy', '사용할 수 없어']):
        fallback.append({'eventId': e['id'], 'reason': e['message']})
    if result.get('outcome') in ['failed', 'uncertain', 'condition-wait', 'held']:
        execution_issues.append(row)
deaths = [e for e in events if e['type'] == 'bot.died']
out = {'observedAt': int(time.time()*1000), 'after': args.after, 'choices': choices,
       'modelDecisionCount': sum(c['source'] == 'laya' for c in choices),
       'singleCandidateChoices': sum(c['candidateCount'] == 1 for c in choices),
       'structuralChoiceViolations': violations, 'executionIssuesRequiringReview': execution_issues,
       'inferenceAvailabilityFallbacks': fallback, 'deathEvents': deaths,
       'outcomes': dict(collections.Counter(c['executionOutcome'] or c['attemptState'] for c in choices)),
       'trained': False, 'newAdapter': None,
       'independentCorrectnessLabels': 0,
       'notes': ['A legal or completed choice is not an independent correct-action label.',
                 'A movement/death/collection failure does not by itself prove a model choice error.',
                 'These unlabelled real episodes are not automatically training data.',
                 'Known evaluation episodes must stay excluded from any later training split.']}
path = pathlib.Path(args.output)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
print(json.dumps({k:v for k,v in out.items() if k in ['modelDecisionCount','singleCandidateChoices',
                 'outcomes','trained','independentCorrectnessLabels']}, ensure_ascii=False))
