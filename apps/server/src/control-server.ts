import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  BotInputSchema, BotPatchSchema, GoalInputSchema, GoalPatchSchema, RulesPatchSchema, BlueprintInputSchema,
  type Agent, type BotInput, type BotPatch, type CoreEvent, type ExecutionMode,
  type FleetCheckpoint, type FleetSnapshot, type GoalInput, type GoalPatch,
  type Interpretation, type Rules, type RulesPatch, type BlueprintInput, type BlueprintDefinition,
} from '../../../packages/contracts/src';
import { ControlStore, type CommandReceipt, type StoredEvent } from './store';
import { proxyViewerHttp, proxyViewerUpgrade, type ViewerTarget } from './viewer-proxy';

export interface FleetControlPort {
  getSnapshot(): FleetSnapshot;
  checkpoint(): FleetCheckpoint;
  addAgent(input: BotInput, commandId?: string): Agent;
  createGoal(input: GoalInput, commandId?: string): unknown;
  createBlueprint(input: BlueprintInput, commandId?: string): unknown;
  updateBlueprint(blueprintId: string, input: BlueprintInput, commandId?: string): unknown;
  deleteBlueprint(blueprintId: string, commandId?: string): unknown;
  updateGoal(goalId: string, patch: GoalPatch, commandId?: string): unknown;
  cancelGoal(goalId: string, commandId?: string): unknown;
  updateRules(patch: RulesPatch, mode?: ExecutionMode, commandId?: string): unknown;
  updateAgent(botId: string, patch: BotPatch, mode?: ExecutionMode, commandId?: string): Agent;
  removeAgent(botId: string, commandId?: string): unknown;
  pauseAgent(botId: string, commandId?: string): unknown;
  resumeAgent(botId: string, commandId?: string): Agent;
  requestViewer(botId: string, enabled: boolean, port?: number, commandId?: string): unknown;
}
export interface ControlServerOptions {
  core: FleetControlPort;
  store: ControlStore;
  startBot?: (agent: Agent) => void | Promise<void>;
  interpret?: (text: string, rules: Rules, blueprints?: readonly BlueprintDefinition[]) => Promise<Interpretation>;
  host?: string;
  port?: number;
  viewerPortBase?: number;
  allowedOrigins?: string[];
  now?: () => number;
  webRoot?: string;
}
const modeSchema = z.enum(['queued', 'immediate']).default('queued');
const botPatchRequest = z.object({ patch: BotPatchSchema, mode: modeSchema }).strict();
const rulesPatchRequest = z.object({ patch: RulesPatchSchema, mode: modeSchema }).strict();
const interpretRequest = z.object({ text: z.string().trim().min(1).max(500) }).strict();
const emptyRequest = z.object({}).strict();

export function createControlServer(options: ControlServerOptions) {
  const { core, store } = options;
  const clients = new Set<ServerResponse>();
  const viewerPorts = new Map<string, number>();
  const allocatedPorts = new Set<number>();
  let dirtySnapshot = false;
  let checkpointDirty = false;
  let closed = false;

  function sendStream(res: ServerResponse, event: string, value: unknown, id?: string): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 512 * 1024) { clients.delete(res); res.destroy(); return; }
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function broadcast(event: string, value: unknown, id?: string): void {
    for (const client of clients) sendStream(client, event, value, id);
  }
  function commandUpdate(id: string, state: 'applying' | 'applied' | 'failed', result?: unknown, error?: string): void {
    const receipt = store.updateCommand(id, state, result, error);
    if (receipt) broadcast('command', receipt);
  }

  /** Connect this function to FleetController.onChange after constructing the controller. */
  function observe(_snapshot: FleetSnapshot, event: CoreEvent): void {
    if (closed) return;
    dirtySnapshot = true;
    const heartbeat = event.type === 'bot.status';
    if (heartbeat) checkpointDirty = true;
    else {
      store.saveCheckpoint(core.checkpoint(), event as unknown as StoredEvent);
      checkpointDirty = false;
      broadcast('event', event, event.id);
    }
    if (event.commandId && event.type === 'command.applied') commandUpdate(event.commandId, 'applied', event.data);
    if (event.commandId && event.type === 'command.failed') commandUpdate(event.commandId, 'failed', undefined, event.message);
  }

  function viewerTarget(botId: string): ViewerTarget | undefined {
    const agent = core.getSnapshot().agents.find(bot => bot.id === botId);
    if (!agent?.session || agent.session.state === 'stopped' || agent.viewer.state !== 'ready') return undefined;
    const expected = viewerPorts.get(botId);
    const prefix = `/viewer/${encodeURIComponent(botId)}`;
    if (agent.viewer.port !== expected || agent.viewer.prefix !== prefix || expected === undefined) return undefined;
    return { botId, sessionId: agent.session.id, port: expected, prefix };
  }
  function getViewerPort(botId: string): number {
    const existing = viewerPorts.get(botId);
    if (existing !== undefined) return existing;
    let candidate = options.viewerPortBase ?? 4100;
    while (allocatedPorts.has(candidate)) candidate += 1;
    if (candidate > 65535) throw new HttpError(503, 'VIEWER_PORTS_EXHAUSTED', '3D 화면 포트를 할당할 수 없습니다.');
    allocatedPorts.add(candidate);
    viewerPorts.set(botId, candidate);
    return candidate;
  }
  async function startEnabledAgent(agent: Agent): Promise<void> {
    if (agent.config.enabled && (!agent.session || agent.session.state === 'stopped')) await options.startBot?.(agent);
  }

  async function mutate(req: IncomingMessage, type: string, value: unknown, apply: (commandId: string) => unknown | Promise<unknown>): Promise<CommandReceipt> {
    const header = req.headers['idempotency-key'];
    if (Array.isArray(header) || (header !== undefined && (header.length < 1 || header.length > 160))) {
      throw new HttpError(400, 'INVALID_REQUEST_KEY', '요청 키는 1~160자여야 합니다.');
    }
    const accepted = store.acceptCommand(header ?? randomUUID(), randomUUID(), type, value);
    if (accepted.duplicate) return accepted.receipt;
    broadcast('command', accepted.receipt);
    commandUpdate(accepted.receipt.id, 'applying');
    try {
      await apply(accepted.receipt.id);
    } catch (error) {
      commandUpdate(accepted.receipt.id, 'failed', undefined, errorMessage(error));
    }
    // The applied callback may have run before the HTTP response is written.
    return store.getCommand(accepted.receipt.id)!;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const viewer = path.match(/^\/viewer\/([^/]+)(?:\/|$)/);
      const viewerPolling = /^\/viewer\/[^/]+\/socket\.io\/?$/.test(path);
      if (viewer && (req.method === 'GET' || req.method === 'POST' && viewerPolling)) {
        validateOrigin(req, options.allowedOrigins);
        const target = viewerTarget(decodeURIComponent(viewer[1]!));
        if (!target) throw new HttpError(503, 'VIEWER_UNAVAILABLE', '선택한 봇의 3D 화면이 준비되지 않았습니다.');
        proxyViewerHttp(req, res, target);
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/health') {
        json(res, 200, { ok: true, controllerEpoch: core.getSnapshot().controllerEpoch }); return;
      }
      if (req.method === 'GET' && path === '/api/v1/snapshot') { json(res, 200, core.getSnapshot()); return; }
      if (req.method === 'GET' && path === '/api/v1/blueprints') { json(res, 200, core.getSnapshot().blueprints); return; }
      if (req.method === 'GET' && path === '/api/v1/events') {
        const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000) throw new HttpError(400, 'INVALID_LIMIT', '이벤트 수는 1~1000이어야 합니다.');
        json(res, 200, store.listEvents(requestedLimit, url.searchParams.get('after') ?? undefined)); return;
      }
      if (req.method === 'GET' && path === '/api/v1/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        sendStream(res, 'snapshot', core.getSnapshot());
        const lastId = req.headers['last-event-id'];
        if (typeof lastId === 'string') for (const event of store.listEvents(200, lastId)) sendStream(res, 'event', event, event.id);
        req.on('close', () => clients.delete(res));
        return;
      }
      const commandPath = path.match(/^\/api\/v1\/commands\/([^/]+)$/);
      if (req.method === 'GET' && commandPath) {
        const receipt = store.getCommand(decodeURIComponent(commandPath[1]!));
        if (!receipt) throw new HttpError(404, 'COMMAND_NOT_FOUND', '명령을 찾을 수 없습니다.');
        json(res, 200, receipt); return;
      }
      if (req.method === 'GET' && options.webRoot && !path.startsWith('/api/') && !path.startsWith('/viewer/')) {
        if (await serveWeb(req, res, options.webRoot, path)) return;
      }
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
      validateControlRequest(req, options.allowedOrigins);
      const value = await readBody(req);
      let receipt: CommandReceipt;
      if (req.method === 'POST' && path === '/api/v1/goals/interpret') {
        const input = interpretRequest.parse(value);
        if (!options.interpret) throw new HttpError(503, 'INTERPRETER_UNAVAILABLE', '목표 해석 기능이 준비되지 않았습니다.');
        const snapshot = core.getSnapshot();
        const interpretation = await options.interpret(input.text, snapshot.rules, snapshot.blueprints);
        json(res, 200, { ...interpretation, goal: GoalInputSchema.parse(interpretation.goal) }); return;
      } else if (req.method === 'POST' && path === '/api/v1/blueprints') {
        const input = BlueprintInputSchema.parse(value);
        receipt = await mutate(req, 'blueprint.create', input, id => core.createBlueprint(input, id));
      } else if (req.method === 'POST' && path === '/api/v1/bots') {
        const raw = z.record(z.string(), z.unknown()).parse(value);
        const connection = raw.connection && typeof raw.connection === 'object' ? raw.connection as Record<string, unknown> : {};
        const input = BotInputSchema.parse({ ...raw, connection: { host: '127.0.0.1', port: 25566, auth: 'offline', ...connection } });
        receipt = await mutate(req, 'bot.add', input, async commandId => {
          const agent = core.addAgent(input, commandId);
          await startEnabledAgent(agent);
        });
      } else if (req.method === 'POST' && path === '/api/v1/goals') {
        const input = GoalInputSchema.parse(value);
        if (input.source !== 'user') throw new HttpError(400, 'INVALID_GOAL_SOURCE', '화면에서 등록하는 목표는 사용자 목표여야 합니다.');
        receipt = await mutate(req, 'goal.create', input, id => core.createGoal(input, id));
      } else if (req.method === 'PATCH' && path === '/api/v1/rules') {
        const input = rulesPatchRequest.parse(value);
        receipt = await mutate(req, 'rules.update', input, id => core.updateRules(input.patch, input.mode, id));
      } else {
        const botPath = path.match(/^\/api\/v1\/bots\/([^/]+)(?:\/(remove|pause|resume|viewer))?$/);
        const goalPath = path.match(/^\/api\/v1\/goals\/([^/]+)(?:\/(cancel))?$/);
        const blueprintPath = path.match(/^\/api\/v1\/blueprints\/([^/]+)$/);
        if (blueprintPath) {
          const blueprintId = decodeURIComponent(blueprintPath[1]!);
          if (req.method === 'PATCH') {
            const input = BlueprintInputSchema.parse(value);
            receipt = await mutate(req, 'blueprint.update', { blueprintId, input }, id => core.updateBlueprint(blueprintId, input, id));
          } else if (req.method === 'DELETE') {
            emptyRequest.parse(value);
            receipt = await mutate(req, 'blueprint.delete', { blueprintId }, id => core.deleteBlueprint(blueprintId, id));
          } else throw new HttpError(404, 'NOT_FOUND', '요청한 설계도 기능을 찾을 수 없습니다.');
        } else if (botPath) {
          const botId = decodeURIComponent(botPath[1]!);
          const action = botPath[2];
          if (req.method === 'PATCH' && !action) {
            const input = botPatchRequest.parse(value);
            receipt = await mutate(req, 'bot.update', { botId, ...input }, async id => {
              const agent = core.updateAgent(botId, input.patch, input.mode, id);
              await startEnabledAgent(agent);
            });
          } else if (action === 'viewer' && (req.method === 'POST' || req.method === 'DELETE')) {
            emptyRequest.parse(value);
            const enabled = req.method === 'POST';
            const port = getViewerPort(botId);
            receipt = await mutate(req, enabled ? 'viewer.start' : 'viewer.stop', { botId, enabled }, id => core.requestViewer(botId, enabled, port, id));
          } else if (req.method === 'POST' && action && ['remove', 'pause', 'resume'].includes(action)) {
            emptyRequest.parse(value);
            receipt = await mutate(req, `bot.${action}`, { botId }, async id => {
              if (action === 'remove') return core.removeAgent(botId, id);
              if (action === 'pause') return core.pauseAgent(botId, id);
              const agent = core.resumeAgent(botId, id);
              await startEnabledAgent(agent);
              return agent;
            });
          } else throw new HttpError(404, 'NOT_FOUND', '요청한 봇 기능을 찾을 수 없습니다.');
        } else if (goalPath) {
          const goalId = decodeURIComponent(goalPath[1]!);
          if (req.method === 'PATCH' && !goalPath[2]) {
            const input = GoalPatchSchema.parse(value);
            receipt = await mutate(req, 'goal.update', { goalId, patch: input }, id => core.updateGoal(goalId, input, id));
          } else if (req.method === 'POST' && goalPath[2] === 'cancel') {
            emptyRequest.parse(value);
            receipt = await mutate(req, 'goal.cancel', { goalId }, id => core.cancelGoal(goalId, id));
          } else throw new HttpError(404, 'NOT_FOUND', '요청한 목표 기능을 찾을 수 없습니다.');
        } else throw new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
      }
      json(res, receipt.state === 'failed' ? 409 : 202, receipt);
    } catch (error) { respondError(res, error); }
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      validateOrigin(req, options.allowedOrigins);
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const match = path.match(/^\/viewer\/([^/]+)\/socket\.io\/?$/);
      const target = match ? viewerTarget(decodeURIComponent(match[1]!)) : undefined;
      if (!target) return socket.destroy();
      proxyViewerUpgrade(req, socket, head, target);
    } catch { socket.destroy(); }
  });

  const snapshotTimer = setInterval(() => {
    if (checkpointDirty) { store.saveCheckpoint(core.checkpoint()); checkpointDirty = false; }
    if (dirtySnapshot) { broadcast('snapshot', core.getSnapshot()); dirtySnapshot = false; }
  }, 1000);
  snapshotTimer.unref();
  const keepAliveTimer = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15_000);
  keepAliveTimer.unref();
  const pruneTimer = setInterval(() => store.prune(core.getSnapshot().rules.logRetentionDays), 60 * 60 * 1000);
  pruneTimer.unref();

  async function listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 3001, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    store.prune(core.getSnapshot().rules.logRetentionDays);
    return server.address() as AddressInfo;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(snapshotTimer); clearInterval(keepAliveTimer); clearInterval(pruneTimer);
    store.saveCheckpoint(core.checkpoint());
    for (const client of clients) client.end();
    clients.clear();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { server, listen, close, observe, broadcastCommand: (receipt: CommandReceipt) => broadcast('command', receipt) };
}

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function respondError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  if (error instanceof z.ZodError) {
    json(res, 400, { error: { code: 'INVALID_INPUT', message: '입력 내용을 확인해 주세요.', details: error.issues } }); return;
  }
  const detail = error as { statusCode?: number; code?: string };
  const status = detail.statusCode ?? (detail.code === 'GOAL_UNSUPPORTED' ? 422 : 400);
  json(res, status, { error: { code: detail.code ?? 'REQUEST_FAILED', message: errorMessage(error) } });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > 64 * 1024) throw new HttpError(413, 'BODY_TOO_LARGE', '요청 본문은 64KB를 넘을 수 없습니다.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; }
  catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 요청 내용을 확인해 주세요.'); }
}
function validateControlRequest(req: IncomingMessage, allowedOrigins?: string[]): void {
  if (req.headers['x-laya-control'] !== '1') throw new HttpError(403, 'CONTROL_HEADER_REQUIRED', '화면에서 제어 요청을 보내 주세요.');
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', 'application/json 형식이 필요합니다.');
  validateOrigin(req, allowedOrigins);
}
function validateOrigin(req: IncomingMessage, allowedOrigins?: string[]): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'INVALID_ORIGIN', '허용되지 않은 요청 출처입니다.'); }
  if (allowedOrigins?.includes(origin)) return;
  const requestHost = req.headers.host?.split(':')[0];
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !['127.0.0.1', 'localhost'].includes(requestHost ?? '')) throw new HttpError(403, 'INVALID_ORIGIN', '허용되지 않은 요청 출처입니다.');
}

async function serveWeb(req: IncomingMessage, res: ServerResponse, webRoot: string, pathname: string): Promise<boolean> {
  const root = await realpath(webRoot).catch(() => undefined);
  if (!root) return false;
  const decoded = decodeURIComponent(pathname);
  const requested = resolve(root, `.${decoded}`);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) throw new HttpError(403, 'INVALID_ASSET_PATH', '허용되지 않은 파일 경로입니다.');
  let file = await realpath(requested).catch(() => undefined);
  if (file && !(await stat(file)).isFile()) file = undefined;
  if (!file && !pathname.startsWith('/assets/')) file = await realpath(resolve(root, 'index.html')).catch(() => undefined);
  if (!file) return false;
  if (!file.startsWith(`${root}${sep}`)) throw new HttpError(403, 'INVALID_ASSET_PATH', '허용되지 않은 파일 경로입니다.');
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'" });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
  stream.pipe(res);
  return true;
}
