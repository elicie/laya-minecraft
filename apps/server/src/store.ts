import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CommandReceipt, JsonValue } from '../../../packages/contracts/src';

export type CommandStatus = 'accepted' | 'applying' | 'applied' | 'failed';
export type { CommandReceipt } from '../../../packages/contracts/src';
export interface WorkerRecord {
  botId: string;
  sessionId: string;
  controllerEpoch: string;
  pid: number;
  startedAt: number;
}
export interface StoredEvent {
  id: string;
  time: number;
  type: string;
  [key: string]: unknown;
}

/** Only the controller opens the database; child processes communicate through IPC. */
export class ControlStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
        request TEXT NOT NULL, receipt TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        time INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(time);
      CREATE TABLE IF NOT EXISTS workers (bot_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
  }

  loadCheckpoint<T>(): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get('checkpoint');
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  saveCheckpoint(checkpoint: unknown, event?: StoredEvent): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('checkpoint', JSON.stringify(checkpoint));
      if (event) this.appendEvent(event);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  appendEvent(event: StoredEvent): void {
    this.db.prepare('INSERT OR IGNORE INTO events (id,time,payload) VALUES (?,?,?)')
      .run(event.id, event.time, JSON.stringify(event));
  }

  listEvents(limit = 100, afterId?: string): StoredEvent[] {
    const bounded = Math.min(1000, Math.max(1, Math.floor(limit)));
    if (afterId) {
      const row = this.db.prepare('SELECT seq FROM events WHERE id = ?').get(afterId);
      if (row) return this.db.prepare('SELECT payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(Number(row.seq), bounded).map(row => JSON.parse(String(row.payload)) as StoredEvent);
    }
    return this.db.prepare('SELECT payload FROM (SELECT seq,payload FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(bounded).map(row => JSON.parse(String(row.payload)) as StoredEvent);
  }

  /** The same key with different input is a conflict, never another action. */
  acceptCommand(idempotencyKey: string, id: string, type: string, request: unknown): { receipt: CommandReceipt; duplicate: boolean } {
    const encoded = canonicalJson({ type, request });
    const previous = this.db.prepare('SELECT request,receipt FROM commands WHERE idempotency_key = ?').get(idempotencyKey);
    if (previous) {
      if (previous.request !== encoded) throw new IdempotencyConflict();
      return { receipt: JSON.parse(String(previous.receipt)) as CommandReceipt, duplicate: true };
    }
    const time = this.now();
    const receipt: CommandReceipt = { id, type, state: 'accepted', createdAt: time, updatedAt: time };
    this.db.prepare('INSERT INTO commands (id,idempotency_key,request,receipt,updated_at) VALUES (?,?,?,?,?)')
      .run(id, idempotencyKey, encoded, JSON.stringify(receipt), time);
    return { receipt, duplicate: false };
  }

  getCommand(id: string): CommandReceipt | undefined {
    const row = this.db.prepare('SELECT receipt FROM commands WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.receipt)) as CommandReceipt : undefined;
  }

  updateCommand(id: string, status: CommandStatus, result?: unknown, error?: string): CommandReceipt | undefined {
    const receipt = this.getCommand(id);
    if (!receipt) return undefined;
    if (receipt.state === 'applied' || receipt.state === 'failed') return receipt;
    const next: CommandReceipt = { ...receipt, state: status, updatedAt: this.now() };
    if (result !== undefined) next.result = JSON.parse(JSON.stringify(result)) as JsonValue;
    if (error !== undefined) next.error = error;
    this.db.prepare('UPDATE commands SET receipt=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(next), next.updatedAt, id);
    return next;
  }

  pendingCommands(): CommandReceipt[] {
    return this.db.prepare('SELECT receipt FROM commands').all()
      .map(row => JSON.parse(String(row.receipt)) as CommandReceipt)
      .filter(receipt => receipt.state === 'accepted' || receipt.state === 'applying');
  }

  commandEvent(commandId: string): StoredEvent | undefined {
    const row = this.db.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.commandId') = ? AND json_extract(payload, '$.type') IN ('command.applied','command.failed') ORDER BY seq DESC LIMIT 1").get(commandId);
    return row ? JSON.parse(String(row.payload)) as StoredEvent : undefined;
  }

  saveWorker(record: WorkerRecord): void {
    this.db.prepare('INSERT INTO workers (bot_id,payload) VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET payload=excluded.payload')
      .run(record.botId, JSON.stringify(record));
  }
  workers(): WorkerRecord[] {
    return this.db.prepare('SELECT payload FROM workers').all().map(row => JSON.parse(String(row.payload)) as WorkerRecord);
  }
  removeWorker(botId: string, sessionId: string): void {
    const current = this.workers().find(worker => worker.botId === botId);
    if (current?.sessionId === sessionId) this.db.prepare('DELETE FROM workers WHERE bot_id=?').run(botId);
  }

  /** Operational history expires; config, goal progress, and outstanding commands do not. */
  prune(retentionDays = 30): number {
    const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
    const events = Number(this.db.prepare('DELETE FROM events WHERE time < ?').run(cutoff).changes);
    const commands = Number(this.db.prepare("DELETE FROM commands WHERE updated_at < ? AND json_extract(receipt, '$.state') IN ('applied','failed')").run(cutoff).changes);
    return events + commands;
  }
  close(): void { this.db.close(); }
}

export class IdempotencyConflict extends Error {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() { super('같은 요청 키가 다른 명령에 사용됐습니다.'); }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
