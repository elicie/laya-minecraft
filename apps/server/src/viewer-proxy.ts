import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ViewerTarget { botId: string; sessionId: string; port: number; prefix: string }

/** Target is a locally allocated worker port, never a user-supplied URL. */
export function proxyViewerHttp(req: IncomingMessage, res: ServerResponse, target: ViewerTarget): void {
  validateTarget(target);
  const upstream = http.request({ hostname: '127.0.0.1', port: target.port,
    path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target.port}` } }, response => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, 'cache-control': 'no-store' });
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message: '봇의 3D 화면을 연결하는 중입니다.', code: 'VIEWER_UNAVAILABLE' } }));
  });
  upstream.setTimeout(30_000, () => upstream.destroy());
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

export function proxyViewerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: ViewerTarget): void {
  validateTarget(target);
  const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${target.port}` } });
  upstream.on('upgrade', (response, source, upstreamHead) => {
    source.setTimeout(0);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
      .map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) source.write(head);
    source.pipe(socket);
    socket.pipe(source);
    source.on('error', () => socket.destroy());
    source.on('close', () => socket.destroy());
    socket.on('error', () => source.destroy());
    socket.on('close', () => source.destroy());
  });
  upstream.on('response', response => { response.resume(); socket.destroy(); });
  upstream.on('error', () => socket.destroy());
  upstream.setTimeout(10_000, () => upstream.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

function validateTarget(target: ViewerTarget): void {
  if (!Number.isInteger(target.port) || target.port < 1024 || target.port > 65535 ||
      target.prefix !== `/viewer/${encodeURIComponent(target.botId)}`) throw new Error('Invalid worker viewer target');
}
