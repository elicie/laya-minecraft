"""Prepare reviewed production/controlled base decisions, grouped before augmentation.

No record is labeled automatically and exported gameplay is not weight training.
The final evaluation shard can be sealed later, after the live third day.
"""
import argparse
import collections
import hashlib
import json
import random
import re
from pathlib import Path
from common import ROOT, MODEL_ID, REVISION, read_json, write_json
from robustness import VARIANTS, variant


def sha(value):
    return hashlib.sha256(value).hexdigest()


def lines(path):
    return [json.loads(row) for row in Path(path).read_text().splitlines() if row.strip()]


def reviewed_rows(paths, question_hash, actions):
    result, seen = [], set()
    for path in paths:
        for row in lines(path):
            if row.get('reviewed') is not True or not row.get('reviewer') or not row.get('rationale'):
                raise ValueError('Unreviewed record: '+str(row.get('id')))
            if row.get('expected') not in actions or row['expected'] not in row.get('allowed', []):
                raise ValueError('Invalid reviewed label: '+row['id'])
            if not set(row['allowed']) <= set(actions) or row.get('source') not in ('production', 'validation'):
                raise ValueError('Invalid source/action scope: '+row['id'])
            if row.get('question_sha256') != question_hash or sha(row['state'].encode()) != row.get('state_sha256'):
                raise ValueError('Question or observation hash mismatch: '+row['id'])
            if not row.get('episode_id') or not row.get('evidence') or row['id'] in seen:
                raise ValueError('Missing evidence or repeated ID: '+row['id'])
            seen.add(row['id'])
            result.append({**row, 'task': 'base_action', 'phase': 'base_'+row['source'],
                           'observation': {'domain': 'base', 'source': row['source'], 'world': row.get('world'), 'run_day': row.get('run_day')},
                           'fingerprint': row['state_sha256']})
    return result


def assert_disjoint(shards):
    for field in ('episode_id', 'state_sha256'):
        groups = {name: {r[field] for r in rows if r['task'] == 'base_action'} for name, rows in shards.items()}
        for left in groups:
            for right in groups:
                if left < right and groups[left] & groups[right]:
                    raise ValueError(f'{field} leakage between {left} and {right}')


def write_rows(run, split, rows):
    content = ''.join(json.dumps(r, ensure_ascii=False)+'\n' for r in rows).encode()
    (run/(split+'.jsonl')).write_bytes(content)
    return sha(content)


def candidate_order_variant(row):
    """A held-out check that the model does not merely copy the first candidate."""
    match = re.search(r'candidates=(\[.*?\]); available_actions=([^;]+)', row['state'])
    if not match:
        return []
    candidates = json.loads(match.group(1))
    if len(candidates) < 2:
        return []
    candidates.reverse()
    replacement = 'candidates='+json.dumps(candidates, separators=(',', ':'))+'; available_actions='+','.join(dict.fromkeys(c['action'] for c in candidates))
    return [{**row, 'id': row['id']+':reverse_candidates', 'original_id': row['id'],
             'variant': 'reverse_candidates', 'state': row['state'][:match.start()]+replacement+row['state'][match.end():]}]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--name', required=True)
    parser.add_argument('--question', default=str(ROOT/'packages/contracts/src/base-decisions.json'))
    parser.add_argument('--train', nargs='+')
    parser.add_argument('--calibration', nargs='+')
    parser.add_argument('--seal-eval', nargs='+')
    parser.add_argument('--replay-per-class', type=int, default=8)
    args = parser.parse_args()
    question_path = Path(args.question); question = read_json(question_path); question_hash = sha(question_path.read_bytes())
    run = ROOT/'training/runs'/args.name
    if args.seal_eval:
        manifest = read_json(run/'manifest.json')
        if manifest.get('eval_sealed') or question_hash != manifest['base_question_sha256']:
            raise ValueError('Evaluation is already sealed or the question changed')
        evaluation = reviewed_rows(args.seal_eval, question_hash, question['criteria'])
        if not evaluation or any(r['source'] == 'production' and r.get('run_day') != 3 for r in evaluation):
            raise ValueError('Production evaluation must come from the blind third day')
        shards = {key: lines(run/(key+'.jsonl')) for key in ('train', 'calibration')}; shards['eval'] = evaluation
        assert_disjoint(shards)
        legacy = lines(ROOT/'training/runs/qwen35-decision-v3/eval.jsonl')
        variants = [variant(row, manifest['questions'], name) for row in evaluation for name in VARIANTS]
        variants += [changed for row in evaluation for changed in candidate_order_variant(row)]
        manifest['split_sha256']['eval'] = write_rows(run, 'eval', legacy+evaluation+variants)
        manifest['counts']['eval'] = len(legacy)+len(evaluation)+len(variants); manifest['eval_sealed'] = True
        manifest['base_eval_originals'] = len(evaluation)
        manifest['base_eval_variants'] = len(variants)
        manifest['eval_sources'] = dict(collections.Counter(r['source'] for r in evaluation))
        write_json(run/'manifest.json', manifest); print(json.dumps({'sealed': True, 'eval': manifest['counts']['eval']})); return
    if not args.train or not args.calibration or run.exists():
        raise ValueError('Provide reviewed train/calibration files and a fresh run name')
    train = reviewed_rows(args.train, question_hash, question['criteria'])
    calibration = reviewed_rows(args.calibration, question_hash, question['criteria'])
    if not train or not calibration or any(r['source'] == 'production' and (r.get('run_day') or 0) >= 3 for r in train+calibration):
        raise ValueError('Training/calibration must exclude production day three')
    assert_disjoint({'train': train, 'calibration': calibration})
    if set(r['expected'] for r in train) != set(question['criteria']):
        raise ValueError('Every deployed base label needs reviewed training coverage')
    parent = ROOT/'training/runs/qwen35-decision-v3'; parent_manifest = read_json(parent/'manifest.json')
    questions = {**parent_manifest['questions'], 'base_action': question}
    replay_groups = collections.defaultdict(list)
    for row in lines(parent/'train.jsonl'):
        if not isinstance(row.get('variant'), str):
            replay_groups[(row['task'], row['expected'])].append(row)
    rng = random.Random(42); replay = []
    for group in replay_groups.values():
        rng.shuffle(group); replay.extend(group[:args.replay_per_class])
    grouped = collections.defaultdict(list)
    for row in train: grouped[row['expected']].append(row)
    selected = []
    for group in grouped.values():
        rng.shuffle(group); selected.extend(group[:6])
    augmented = [variant(r, questions, name) for r in selected for name in VARIANTS]
    legacy_cal_groups = collections.defaultdict(list)
    for row in lines(parent/'calibration.jsonl'):
        if not isinstance(row.get('variant'), str): legacy_cal_groups[(row['task'], row['expected'])].append(row)
    legacy_cal = [row for group in legacy_cal_groups.values() for row in group[:4]]
    shards = {'train': replay+selected+augmented, 'calibration': legacy_cal+calibration, 'eval': []}
    run.mkdir(parents=True); output = ROOT/'checkpoints'/args.name
    if output.exists(): raise ValueError('Adapter output already exists')
    manifest = {'base': MODEL_ID, 'revision': REVISION, 'adapter': str(output),
                'parent_adapter': str(ROOT/'checkpoints/qwen35-decision-v3'), 'questions': questions,
                'base_question_sha256': question_hash, 'split_sha256': {k: write_rows(run, k, rows) for k, rows in shards.items()},
                'counts': {k: len(v) for k, v in shards.items()}, 'eval_sealed': False,
                'reviewed_base_originals': len(selected), 'base_training_sources': dict(collections.Counter(r['source'] for r in selected)),
                'reviewers': sorted(set(r['reviewer'] for r in train+calibration)),
                'note': 'Reviewed natural gameplay and explicitly marked disposable-server observations. Assistant reviews are not human annotation. Episode and state hashes are separated before variants. Third-day production records stay blind; calibration claims are limited to this Minecraft distribution.'}
    write_json(run/'manifest.json', manifest); print(json.dumps({'prepared': True, 'trained': False, 'counts': manifest['counts']}))


if __name__ == '__main__':
    main()
