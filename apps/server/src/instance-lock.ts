import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Prevent two controllers from writing the same state or commanding the same bots. */
export function acquireInstanceLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  // A separate SQLite file holds an OS-backed exclusive lock for this lifetime.
  // The OS releases it after a crash, avoiding stale PID files and cleanup races.
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error('동일한 데이터 경로의 컨트롤러가 이미 실행 중입니다.');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    db.exec('ROLLBACK');
    db.close();
  };
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return false;
    }
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

