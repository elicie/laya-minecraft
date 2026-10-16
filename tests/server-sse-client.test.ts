import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SseClient, sseFrame } from '../apps/server/src/sse-client';

class Response extends EventEmitter {
  destroyed = false; writableEnded = false; frames: string[] = []; writable = false;
  write(frame: string) { this.frames.push(frame); return this.writable; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
test('backpressure retains a legal large frame, ordered receipts and only the newest pending snapshot', () => {
  const res = new Response(), client = new SseClient(res as unknown as ServerResponse);
  const initial = sseFrame('snapshot', { revision: 1, proof: 'x'.repeat(1024 * 1024) });
  client.send(initial, 'snapshot');
  client.send(sseFrame('command', { id: 'command', state: 'applying' }));
  for (let revision = 2; revision <= 100; revision++) client.send(sseFrame('snapshot', { revision }), 'snapshot');
  client.send(sseFrame('command', { id: 'command', state: 'applied' })); client.send(': heartbeat\n\n', 'heartbeat');
  assert.equal(res.destroyed, false); assert.deepEqual(res.frames, [initial]);
  res.writable = true; res.emit('drain'); assert.equal(res.frames.length, 4);
  assert.match(res.frames[1]!, /applying/); assert.match(res.frames[2]!, /applied/); assert.match(res.frames[3]!, /"revision":100/); client.close();
});
test('event count, queued bytes and blocked duration are separately bounded with complete cleanup', async () => {
  for (const options of [{ maxQueuedEvents: 1 }, { maxQueuedBytes: 4 }]) {
    const res = new Response(); let closed = 0; const client = new SseClient(res as unknown as ServerResponse, { ...options, onClose: () => closed++ });
    client.send('initial'); client.send('event'); client.send('overflow'); assert.equal(res.destroyed, true); assert.equal(closed, 1); assert.equal(res.listenerCount('drain'), 0);
  }
  const res = new Response(); const client = new SseClient(res as unknown as ServerResponse, { maxBlockedMs: 20 });
  client.send('initial'); for (let i = 0; i < 10; i++) client.send('newest', 'snapshot');
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(res.destroyed, true); assert.equal(res.listenerCount('drain'), 0);
});
test('a drain cancels the old timeout and compressed writer errors close both streams', async () => {
  const res = new Response(), writer = new Response(); const client = new SseClient(res as unknown as ServerResponse, { writer: writer as unknown as ServerResponse, maxBlockedMs: 20 });
  client.send('initial'); writer.writable = true; writer.emit('drain'); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(res.destroyed, false);
  writer.emit('error', new Error('gzip failed')); assert.equal(res.destroyed, true); assert.equal(writer.destroyed, true); assert.equal(writer.listenerCount('drain'), 0);
});
