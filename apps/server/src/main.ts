import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { FleetController } from '../../../packages/core/src';
import { FleetCheckpointSchema, type Agent } from '../../../packages/contracts/src';
import { LayaClient, createGoalInterpreter } from '../../../packages/models/src';
import { createControlServer } from './control-server';
import { acquireInstanceLock } from './instance-lock';
import { reconcileCommandReceipts } from './reconciliation';
import { ControlStore } from './store';
import { WorkerSupervisor } from './supervisor';

export interface RuntimeOptions {
  runtimeDir?: string;
  host?: string;
  port?: number;
  webRoot?: string;
  workerPath?: string;
  workerExecArgv?: string[];
  reconnectDelayMs?: number;
  tickIntervalMs?: number;
}

/** Find a worker whose checkpoint survived a lost registry write without trusting a reused PID. */
function recoverMissingWorkerRecords(store: ControlStore, checkpoint: ReturnType<FleetController['checkpoint']> | undefined): void {
  for (const agent of checkpoint?.agents ?? []) {
    if (!agent.session || agent.session.state === 'stopped' || store.workers().some(record => record.botId === agent.id)) continue;
    const sessionId = agent.session.id;
    const matches: { pid: number; controllerEpoch: string }[] = [];
    let entries: string[];
    try { entries = readdirSync('/proc'); }
    catch { throw new Error(`이전 봇 ${agent.id}의 실행 기록이 없고 프로세스 종료를 확인할 수 없습니다.`); }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      let environment: string;
      try {
        if (process.getuid && statSync(`/proc/${name}`).uid !== process.getuid()) continue;
        environment = readFileSync(`/proc/${name}/environ`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        // User services can share our UID while protecting their environment.
        // A supervisor-created child uses the Node executable, never systemd/PAM.
        if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') {
          let executable: string | undefined;
          try { executable = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')[0]; } catch { /* Keep an unidentifiable Node process fenced. */ }
          if (executable && basename(executable) !== basename(process.execPath)) continue;
        }
        throw new Error(`이전 봇 ${agent.id}의 프로세스 신원을 확인할 수 없습니다.`);
      }
      const fields = environment.split('\0');
      if (!fields.includes(`LAYA_WORKER_SESSION=${sessionId}`)) continue;
      const bootstrap = fields.find(field => field.startsWith('LAYA_WORKER_BOOTSTRAP='));
      try {
        const identity = JSON.parse(bootstrap?.slice('LAYA_WORKER_BOOTSTRAP='.length) ?? '{}') as Record<string, unknown>;
        if (identity.botId !== agent.id || identity.sessionId !== sessionId || typeof identity.controllerEpoch !== 'string') throw new Error('identity mismatch');
        matches.push({ pid: Number(name), controllerEpoch: identity.controllerEpoch });
      } catch { throw new Error(`이전 봇 ${agent.id}의 세션 신원이 일치하지 않습니다.`); }
    }
    if (matches.length > 1) throw new Error(`이전 봇 ${agent.id}의 세션에 여러 프로세스가 있어 안전하게 복구할 수 없습니다.`);
    if (matches[0]) store.saveWorker({ botId: agent.id, sessionId, controllerEpoch: matches[0].controllerEpoch, pid: matches[0].pid, startedAt: Date.now() });
  }
}

export async function startRuntime(options: RuntimeOptions = {}) {
  const runtimeDir = resolve(options.runtimeDir ?? process.env.RUNTIME_DIR ?? 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const release = acquireInstanceLock(join(runtimeDir, 'controller.lock.sqlite'));
  let store: ControlStore | undefined;
  let supervisor: WorkerSupervisor | undefined;
  let core: FleetController | undefined;
  let api: ReturnType<typeof createControlServer> | undefined;
  let closing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  let shutdown: Promise<void> | undefined;
  const reconnectAt = new Map<string, number>();
  function close(): Promise<void> {
    shutdown ??= (async () => {
      closing = true;
      if (timer) clearInterval(timer);
      if (pruneTimer) clearInterval(pruneTimer);
      const errors: unknown[] = [];
      try { core?.dispose(); } catch (error) { errors.push(error); }
      try { await supervisor?.shutdownAll(); } catch (error) { errors.push(error); }
      // Process death and delivery of Node's exit callback are separate moments.
      // Keep the database open until the supervisor has persisted those exits.
      if (supervisor) {
        const deadline = Date.now() + 5000;
        while (supervisor.records().length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
        if (supervisor.records().length) errors.push(new Error('봇 종료 콜백을 확인하지 못했습니다.'));
      }
      try { if (store && core) store.saveCheckpoint(core.checkpoint()); } catch (error) { errors.push(error); }
      try { await api?.close(); } catch (error) { errors.push(error); }
      try { store?.close(); } catch (error) { errors.push(error); }
      try { release(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, '컨트롤러 종료 중 일부 정리를 완료하지 못했습니다.');
    })();
    return shutdown;
  }
  function startBot(agent: Agent): void {
    if (closing || !core || !supervisor || !agent.config.enabled || agent.status === 'removed' || agent.status === 'removing' || supervisor.has(agent.id)) return;
    if (agent.session && agent.session.state !== 'stopped') return;
    const sessionId = randomUUID();
    supervisor.spawn(agent.id, sessionId, core.controllerEpoch, { config: agent.config, rules: core.getSnapshot().rules });
    core.startSession(agent.id, sessionId);
  }
  try {
    store = new ControlStore(join(runtimeDir, 'control.sqlite'));
    const restored = store.loadCheckpoint<unknown>();
    const checkpoint = restored === undefined ? undefined : FleetCheckpointSchema.parse(restored);
    recoverMissingWorkerRecords(store, checkpoint);
    const laya = new LayaClient();
    supervisor = new WorkerSupervisor({
      workerPath: options.workerPath ?? join(__dirname, '../../../packages/minecraft/src/worker' + (__filename.endsWith('.ts') ? '.ts' : '.js')),
      execArgv: options.workerExecArgv,
      store,
      onMessage: (_botId, message) => core!.onWorkerMessage(message),
      onExit: (botId, sessionId) => { core!.confirmWorkerStopped(botId, sessionId); reconnectAt.set(botId, Date.now() + (options.reconnectDelayMs ?? 5000)); },
      onError: (botId, error) => { console.error(`[worker ${botId}] ${error.message}`); },
    });
    core = new FleetController({
      checkpoint,
      send: (botId, message) => supervisor!.send(botId, message),
      decide: (request) => laya.choose(request),
      onChange: (snapshot, event) => {
        if (api) api.observe(snapshot, event);
        else store!.saveCheckpoint(core!.checkpoint(), { ...event });
      },
    });
    const orphans = await supervisor.reconcileOrphans();
    for (const worker of orphans) core.confirmWorkerStopped(worker.botId, worker.sessionId);
    // A checkpoint may have survived after its worker record was already removed.
    for (const agent of core.getSnapshot().agents) if (agent.session && agent.session.state !== 'stopped' && !store.workers().some(record => record.botId === agent.id)) core.confirmWorkerStopped(agent.id, agent.session.id);
    reconcileCommandReceipts(store, checkpoint);
    api = createControlServer({ core, store, startBot, interpret: createGoalInterpreter(),
      host: options.host ?? process.env.API_HOST ?? '127.0.0.1',
      port: options.port ?? Number(process.env.API_PORT ?? 3001),
      webRoot: options.webRoot ?? resolve('dist/web') });
    const address = await api.listen();
    for (const agent of core.getSnapshot().agents) startBot(agent);
    timer = setInterval(() => {
      if (closing) return;
      core!.tick();
      for (const agent of core!.getSnapshot().agents) {
        if (Date.now() < (reconnectAt.get(agent.id) ?? 0)) continue;
        try { startBot(agent); } catch (error) { console.error(error); reconnectAt.set(agent.id, Date.now() + 10000); }
      }
    }, options.tickIntervalMs ?? 1000);
    pruneTimer = setInterval(() => store!.prune(core!.getSnapshot().rules.logRetentionDays), 3600000);
    store.prune(core.getSnapshot().rules.logRetentionDays);
    return { core, store, supervisor, api, address, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '컨트롤러 시작과 종료 정리에 실패했습니다.'); }
    throw error;
  }
}

if (require.main === module) {
  void startRuntime().then(runtime => {
    console.log(`Laya Minecraft: http://${runtime.address.address}:${runtime.address.port}`);
    const stop = () => { void runtime.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
