import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ControlStore, WorkerRecord } from './store';
import { isAlive } from './instance-lock';

export interface WorkerExit { code: number | null; signal: NodeJS.Signals | null; expected: boolean }
export interface SupervisorOptions {
  workerPath: string;
  store: ControlStore;
  onMessage: (botId: string, message: unknown) => void;
  onExit: (botId: string, sessionId: string, exit: WorkerExit) => void;
  onError?: (botId: string, error: Error) => void;
  execArgv?: string[];
  now?: () => number;
}
interface ChildEntry { child: ChildProcess; record: WorkerRecord; expected: boolean }

/** A missing heartbeat never causes another worker to be started. Exit is the fence. */
export class WorkerSupervisor {
  private readonly children = new Map<string, ChildEntry>();
  constructor(private readonly options: SupervisorOptions) {}

  spawn(botId: string, sessionId: string, controllerEpoch: string, bootstrap: { config: unknown; rules: unknown }): WorkerRecord {
    if (this.children.has(botId) || this.options.store.workers().some(worker => worker.botId === botId)) {
      throw new Error(`봇 ${botId}의 이전 프로세스가 아직 종료 확인되지 않았습니다.`);
    }
    const child = fork(this.options.workerPath, [], {
      execArgv: this.options.execArgv ?? process.execArgv,
      env: { ...process.env, LAYA_WORKER_SESSION: sessionId,
        LAYA_WORKER_BOOTSTRAP: JSON.stringify({ ...bootstrap, botId, sessionId, controllerEpoch }) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    if (!child.pid) throw new Error('봇 프로세스를 시작하지 못했습니다.');
    const record: WorkerRecord = { botId, sessionId, controllerEpoch, pid: child.pid, startedAt: (this.options.now ?? Date.now)() };
    const entry: ChildEntry = { child, record, expected: false };
    this.children.set(botId, entry);
    child.on('message', message => this.options.onMessage(botId, message));
    child.on('error', error => this.options.onError?.(botId, error));
    child.once('exit', (code, signal) => {
      this.children.delete(botId);
      this.options.store.removeWorker(botId, sessionId);
      this.options.onExit(botId, sessionId, { code, signal, expected: entry.expected });
    });
    try { this.options.store.saveWorker(record); }
    catch (error) {
      entry.expected = true;
      child.kill('SIGTERM');
      throw error;
    }
    return record;
  }

  send(botId: string, message: unknown): void {
    const entry = this.children.get(botId);
    if (!entry?.child.connected) {
      this.options.onError?.(botId, new Error('봇 IPC가 연결돼 있지 않습니다.'));
      return;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'bot.shutdown') entry.expected = true;
    entry.child.send(message as object, error => { if (error) this.options.onError?.(botId, error); });
  }
  records(): WorkerRecord[] { return [...this.children.values()].map(entry => ({ ...entry.record })); }
  has(botId: string): boolean { return this.children.has(botId); }

  async requestStop(botId: string, graceMs = 5000): Promise<void> {
    const entry = this.children.get(botId);
    if (!entry) return;
    entry.expected = true;
    entry.child.kill('SIGTERM');
    await waitUntilStopped(entry.record.pid, graceMs);
    if (isAlive(entry.record.pid)) {
      entry.child.kill('SIGKILL');
      await waitUntilStopped(entry.record.pid, 3000);
    }
    if (isAlive(entry.record.pid)) throw new Error(`봇 ${botId}의 프로세스 종료를 확인하지 못했습니다.`);
  }

  async shutdownAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.children.keys()].map(id => this.requestStop(id)));
    const failed = outcomes.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  /** Reconcile children of a crashed controller before restored work is scheduled. */
  async reconcileOrphans(): Promise<WorkerRecord[]> {
    const stopped: WorkerRecord[] = [];
    for (const record of this.options.store.workers()) {
      if (isAlive(record.pid)) {
        // A reused PID is not ours. Never signal a process without matching session identity.
        let environment: string;
        try { environment = readFileSync(`/proc/${record.pid}/environ`, 'utf8'); }
        catch { throw new Error(`이전 봇 ${record.botId}의 프로세스 신원을 확인할 수 없습니다.`); }
        if (environment.split('\0').includes(`LAYA_WORKER_SESSION=${record.sessionId}`)) {
          process.kill(record.pid, 'SIGTERM');
          await waitUntilStopped(record.pid, 5000);
          if (isAlive(record.pid)) { process.kill(record.pid, 'SIGKILL'); await waitUntilStopped(record.pid, 3000); }
          if (isAlive(record.pid)) throw new Error(`이전 봇 ${record.botId}의 종료를 확인하지 못했습니다.`);
        }
      }
      this.options.store.removeWorker(record.botId, record.sessionId);
      stopped.push(record);
    }
    return stopped;
  }
}

async function waitUntilStopped(pid: number, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (isAlive(pid) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 30));
}
