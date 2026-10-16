import type { ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';

export interface SseClientOptions {
  maxQueuedBytes?: number;
  maxQueuedEvents?: number;
  maxBlockedMs?: number;
  onClose?(): void;
  writer?: Writable;
}

/** One writable frame, a bounded event queue, and one replaceable latest state. */
export class SseClient {
  private blocked = false;
  private closed = false;
  private events: string[] = [];
  private queuedBytes = 0;
  private latestSnapshot?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly writer: Writable;
  constructor(private readonly response: ServerResponse, private readonly options: SseClientOptions = {}) {
    this.writer = options.writer ?? response;
    this.writer.on('drain', this.drain);
    if (this.writer !== response) this.writer.on('error', this.fail);
    response.on('close', this.dispose);
    response.on('error', this.dispose);
  }
  send(frame: string, kind: 'snapshot' | 'event' | 'heartbeat' = 'event'): void {
    if (this.closed || this.response.destroyed || this.response.writableEnded) return;
    if (this.blocked) {
      if (kind === 'snapshot') this.latestSnapshot = frame;
      else if (kind === 'event') {
        const size = Buffer.byteLength(frame);
        if (this.events.length >= (this.options.maxQueuedEvents ?? 256) || this.queuedBytes + size > (this.options.maxQueuedBytes ?? 512 * 1024)) { this.close(); return; }
        this.events.push(frame); this.queuedBytes += size;
      }
      return;
    }
    this.write(frame);
  }
  private write(frame: string): void {
    if (this.closed) return;
    let writable: boolean;
    try { writable = this.writer.write(frame); }
    catch { this.close(); return; }
    if (!writable) {
      this.blocked = true;
      this.timer = setTimeout(() => this.close(), this.options.maxBlockedMs ?? 30000);
      this.timer.unref();
    }
  }
  private readonly drain = (): void => {
    if (this.closed) return;
    clearTimeout(this.timer); this.timer = undefined; this.blocked = false;
    while (this.events.length && !this.blocked && !this.closed) {
      const frame = this.events.shift()!; this.queuedBytes -= Buffer.byteLength(frame); this.write(frame);
    }
    if (!this.blocked && this.latestSnapshot !== undefined) {
      const frame = this.latestSnapshot; this.latestSnapshot = undefined; this.write(frame);
    }
  };
  private readonly dispose = (): void => {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    this.events = []; this.queuedBytes = 0; this.latestSnapshot = undefined;
    this.writer.off('drain', this.drain);
    if (this.writer !== this.response) { this.writer.off('error', this.fail); this.writer.destroy(); }
    this.response.off('close', this.dispose); this.response.off('error', this.dispose);
    this.options.onClose?.();
  };
  private readonly fail = (): void => { this.close(); };
  close(): void { if (this.closed) return; this.dispose(); this.response.destroy(); }
}

export function sseFrame(event: string, value: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}
