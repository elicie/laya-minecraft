"""Read-only, continuous world-time audit of the selected production fleet.

Only opens SQLite in read-only mode. It never controls bots or the world.
Results keep expected night/growth waits separate from blocked work and stalls.
"""
import argparse
import datetime
import hashlib
import json
import math
import pathlib
import sqlite3
from fleet_run_continuity import continuity_problem, expected_wait
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('name')
parser.add_argument('--ticks', type=int, default=72000)
parser.add_argument('--bots', nargs='+', help='Exact Minecraft bot names; defaults to every enabled production bot')
args = parser.parse_args()
OUT = ROOT / 'runtime/validation-runs' / args.name
OUT.mkdir(parents=True, exist_ok=False)
DB = f'file:{ROOT}/runtime/control.sqlite?mode=ro'


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write(name, value):
    p = OUT / name
    tmp = p.with_suffix(p.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(p)


def read_state(after=None):
    with sqlite3.connect(DB, uri=True) as db:
        db.execute('BEGIN')
        state = json.loads(db.execute("select value from state where key='checkpoint'").fetchone()[0])
        seq = db.execute('select coalesce(max(seq),0) from events').fetchone()[0]
        events = [] if after is None else [json.loads(p) for p, in db.execute(
            'select payload from events where seq>? and seq<=? order by seq', (after, seq))]
    return state, seq, events


def source_hash():
    digest = hashlib.sha256()
    for base in ['packages', 'apps/server/src']:
        for p in sorted((ROOT / base).rglob('*')):
            if p.is_file() and p.suffix in ['.ts', '.json']:
                digest.update(str(p.relative_to(ROOT)).encode() + p.read_bytes())
    return digest.hexdigest()


def compact(report):
    return {k: report.get(k) for k in ['ready', 'position', 'health', 'food', 'action', 'reason',
            'mode', 'inventory', 'timeOfDay', 'worldAge', 'nearbyThreatsClear', 'isDay']}


state, seq, _ = read_state()
agents = [a for a in state['agents'] if a['config']['connection']['host'] == 'infra'
          and a['config']['connection']['port'] == 25565 and a['status'] != 'removed'
          and (a['config']['name'] in args.bots if args.bots else a['config']['enabled'])]
assert agents, 'No selected production workers'
if args.bots:
    assert len(set(args.bots)) == len(args.bots), 'Duplicate bot names'
    assert {a['config']['name'] for a in agents} == set(args.bots), 'Unknown selected bot'
starts = {}
for a in agents:
    r = a['session']['report']
    assert a['session']['state'] == 'ready' and r['ready'] and r['health'] > 0
    starts[a['id']] = {'name': a['config']['name'], 'sessionId': a['session']['id'], 'world': r['world'], 'dimension': r['dimension'],
                       'worldAge': r['worldAge'], 'report': compact(r)}
start = {'startedAt': stamp(), 'startedAtMs': int(time.time()*1000),
         'controllerEpoch': state['controllerEpoch'], 'startSeq': seq, 'bots': starts,
         'sourceSha256': source_hash(), 'requiredWorldTicks': args.ticks,
         'monitorSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()+(ROOT/'scripts/fleet_run_continuity.py').read_bytes()).hexdigest(),
         'scope': f'{len(agents)} selected production workers, same final runtime source and uninterrupted sessions',
         'administrativeWorldChanges': False}
write('start.json', start)
tracking = {bid: {'anchor': s['report']['position'], 'items': s['report']['inventory'],
                 'changed': time.monotonic(), 'minHealth': s['report']['health'],
                 'minFood': s['report']['food'], 'lastAge': s['worldAge'],
                 'lastTime': s['report']['timeOfDay'], 'dayWraps': 0, 'nightSamples': 0,
                 'blockedSamples': 0, 'respawnSamples': 0, 'exposedNightSamples': 0, 'stalls': [], 'openStall': None}
            for bid, s in starts.items()}
assigned, completed, failed, deaths, decisions = {}, {}, {}, {}, {}
samples = 0
last_sample = time.monotonic()
max_gap = 0
print(json.dumps({'started': str(OUT), 'start': start}, ensure_ascii=False), flush=True)

while True:
    time.sleep(3)
    state, seq, events = read_state(seq)
    now, wall = int(time.time()*1000), time.monotonic()
    max_gap = max(max_gap, wall-last_sample)
    last_sample = wall
    invalid = None
    if state['controllerEpoch'] != start['controllerEpoch']:
        invalid = 'controller restarted'
    if max_gap > 20:
        invalid = 'observation gap exceeded20seconds'
    if samples % 10 == 0 and source_hash() != start['sourceSha256']:
        invalid = 'runtime source changed'
    with (OUT / 'events.jsonl').open('a') as f:
        for e in events:
            if e.get('botId') not in starts:
                continue
            if e['type'] not in ['world.observed', 'task.progress']:
                f.write(json.dumps(e, ensure_ascii=False)+'\n')
            target = {'task.assigned': assigned, 'task.completed': completed,
                      'task.failed': failed, 'scheduler.decision': decisions}.get(e['type'])
            if target is not None and e.get('attemptId'):
                target[e['attemptId']] = e
            if e['type'] == 'bot.died':
                deaths[e['id']] = e
                tracking[e['botId']]['minHealth'] = 0
    goals = {g['id']: g for g in state['goals']}
    attempts = {a['id']: a for a in state['attempts']}
    reports, elapsed = {}, []
    for bid, original in starts.items():
        a = next(a for a in state['agents'] if a['id'] == bid)
        session = a.get('session', {})
        r, stats = session.get('report', {}), tracking[bid]
        problem = continuity_problem(a, original, now, {e.get('data', {}).get('deathId'): e for e in deaths.values()})
        if problem:
            invalid = problem+': '+bid
        elif not r.get('ready'):
            stats['respawnSamples'] += 1
        age = r.get('worldAge', stats['lastAge'])
        if age < stats['lastAge']:
            invalid = 'worldAge moved backwards: '+bid
        elapsed.append(age-original['worldAge'])
        stats['lastAge'] = age
        tod = r.get('timeOfDay', stats['lastTime'])
        if stats['lastTime'] > 20000 and tod < 4000:
            stats['dayWraps'] += 1
        stats['lastTime'] = tod
        stats['minHealth'] = min(stats['minHealth'], r.get('health', 20))
        stats['minFood'] = min(stats['minFood'], r.get('food', 20))
        active = []
        for t in state['tasks']:
            g = goals.get(t['goalId'], {})
            if g.get('state') in ['completed', 'cancelled'] or g.get('generation') != t.get('generation'):
                continue
            at = attempts.get(t.get('attemptId'), {})
            if at.get('botId') != bid and t.get('affinityBotId') != bid:
                continue
            if t['state'] in ['completed', 'cancelled', 'superseded']:
                continue
            progress = g.get('progress', {})
            if g.get('input', {}).get('mode') == 'maintain' and progress.get('current', 0) >= progress.get('target', 1):
                continue
            active.append({k: t.get(k) for k in ['id', 'kind', 'state', 'reason']})
        shelter = '야간' in r.get('action', '')
        actual_night = r.get('isDay') is False or 9000 <= (r.get('timeOfDay') or 0) < 23000
        night = shelter and actual_night
        expected = expected_wait(r, active)
        if expected == 'night-without-shelter':
            stats['exposedNightSamples'] += 1
        if night:
            stats['nightSamples'] += 1
        if any(t['state'] == 'condition-wait' for t in active) and not night:
            stats['blockedSamples'] += 1
        pos, items = r.get('position'), r.get('inventory')
        moved = pos and stats['anchor'] and math.dist([pos[k] for k in ['x','y','z']],
                                                       [stats['anchor'][k] for k in ['x','y','z']]) >= 2
        if expected or moved or items != stats['items']:
            if stats['openStall'] is not None:
                stats['openStall']['endedAt'] = stamp()
                stats['openStall']['seconds'] = round(wall-stats['changed'], 2)
                stats['openStall'] = None
            stats.update(anchor=pos, items=items, changed=wall)
        duration = wall-stats['changed']
        if duration > 120 and not expected and stats['openStall'] is None:
            stall = {'startedAt': stamp(), 'position': pos, 'action': r.get('action'),
                     'reason': r.get('reason'), 'active': active, 'endedAt': None}
            stats['stalls'].append(stall)
            stats['openStall'] = stall
        reports[bid] = {'report': compact(r), 'active': active, 'expectedWait': expected,
                        'unchangedSeconds': round(duration, 1), 'daylightShelterExitBlocked': shelter and not actual_night}
    samples += 1
    ticks = min(elapsed)
    status = {'updatedAt': stamp(), 'state': 'invalid' if invalid else 'complete' if ticks >= args.ticks else 'running',
              'invalidReason': invalid, 'elapsedWorldTicks': ticks, 'requiredWorldTicks': args.ticks,
              'samples': samples, 'maxSampleGapSeconds': max_gap, 'deathCount': len(deaths),
              'assignedAttempts': len(assigned), 'completedAssignedAttempts': len(assigned.keys() & completed.keys()),
              'failedAttempts': len(failed), 'modelDecisions': sum(e.get('data', {}).get('source') == 'laya' for e in decisions.values()),
              'bots': {bid: {k:v for k,v in stats.items() if k not in ['anchor','items','changed','openStall']}
                       for bid, stats in tracking.items()}, 'latestReports': reports}
    with (OUT / 'samples.jsonl').open('a') as f:
        f.write(json.dumps({'at': stamp(), 'elapsedWorldTicks': ticks, 'bots': reports}, ensure_ascii=False)+'\n')
    write('status.json', status)
    if invalid or ticks >= args.ticks:
        status.update(start=start, deathEvents=list(deaths.values()),
                      assignedAttemptIds=list(assigned), completedAttemptIds=list(completed),
                      failedAttemptIds=list(failed), threeNaturalDayWraps=all(s['dayWraps'] >= 3 for s in tracking.values()))
        write('result.json', status)
        print(json.dumps(status, ensure_ascii=False), flush=True)
        break
