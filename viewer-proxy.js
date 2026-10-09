const http = require('node:http')

function proxyViewer(req, res, target) {
  const upstream = http.request({hostname: '127.0.0.1', port: target.port, path: req.url, method: req.method, headers: req.headers}, response => {
    res.writeHead(response.statusCode, {...response.headers, 'Cache-Control': 'no-store'})
    response.on('error', () => res.destroy())
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(503, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'})
    res.end(JSON.stringify({error: '봇의 관전 화면을 연결하는 중입니다.'}))
  })
  upstream.setTimeout(30000, () => upstream.destroy())
  req.on('aborted', () => upstream.destroy())
  res.on('close', () => {if (!res.writableEnded) upstream.destroy()})
  req.pipe(upstream)
}

function proxyViewerUpgrade(req, socket, head, target) {
  const upstream = http.request({hostname: '127.0.0.1', port: target.port, path: req.url, headers: req.headers})
  upstream.on('upgrade', (response, source, upstreamHead) => {
    source.setTimeout(0)
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n')
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) source.write(head)
    source.pipe(socket)
    socket.pipe(source)
    source.on('error', () => socket.destroy())
    source.on('close', () => socket.destroy())
    socket.on('error', () => source.destroy())
    socket.on('close', () => source.destroy())
  })
  upstream.on('response', response => {response.resume(); socket.destroy()})
  upstream.on('error', () => socket.destroy())
  upstream.setTimeout(10000, () => upstream.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.end()
}

module.exports = {proxyViewer, proxyViewerUpgrade}
