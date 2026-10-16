"""Pure checks for a continuous client session, including confirmed respawns."""


def continuity_problem(agent, original, now, deaths):
    session = agent.get('session', {})
    report = session.get('report', {})
    if session.get('id') != original['sessionId']:
        return 'worker session changed'
    if session.get('state') != 'ready':
        return 'worker session is ' + str(session.get('state'))
    if now - session.get('lastReportAt', 0) > 20000:
        return 'worker report stale'
    if report.get('world') != original['world'] or report.get('dimension') != original['dimension']:
        return 'worker world or dimension changed'
    if report.get('ready'):
        return None
    recovery = agent.get('recovery') or {}
    confirmed = deaths.get(recovery.get('deathId'))
    if (confirmed and confirmed.get('botId') == agent['id']
            and recovery.get('phase') in ['waiting-respawn', 'recovering']
            and 0 <= now - recovery.get('occurredAt', 0) <= 30000):
        return None
    return 'worker unready without a fresh confirmed respawn'


def expected_wait(report, active):
    action = report.get('action', '')
    night = report.get('isDay') is False or 9000 <= (report.get('timeOfDay') or 0) < 23000
    if night and action == '안전한 대피처 대기':
        return 'night-without-shelter'
    if night and '야간' in action:
        return 'night-shelter'
    if not active:
        return 'no-active-work'
    return None
