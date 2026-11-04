const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');

// Only this test profile uses the proxy; the user's network and other apps are untouched.
async function faultProxy(origin) {
  const target = new URL(origin);
  if (target.protocol !== 'http:') throw new Error('The local fault proxy requires HTTP.');
  let offline = false;
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const server = http.createServer((request, response) => {
    if (offline) { request.socket.destroy(); return; }
    const url = new URL(request.url, origin);
    if (url.origin !== origin) { response.writeHead(403).end(); return; }
    const upstream = http.request(url, { method: request.method, headers: request.headers, timeout: 15_000 }, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => response.destroy());
    upstream.on('timeout', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
  let connected = false;
  server.on('connection', socket => {
    if (sockets.size >= 64) { socket.destroy(); return; }
    track(socket);
  });
  server.on('upgrade', (request, socket, head) => {
    if (offline || new URL(request.url, origin).origin !== origin) { socket.destroy(); return; }
    const upstream = net.connect(Number(target.port || 80), target.hostname);
    track(upstream);
    upstream.on('connect', () => {
      connected = true; server.emit('qa-websocket');
      const path = new URL(request.url, origin);
      upstream.write(`${request.method} ${path.pathname}${path.search} HTTP/1.1\r\n${Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  // Chromium tunnels WebSockets through HTTP proxies with CONNECT, even for ws://.
  server.on('connect', (request, socket, head) => {
    if (offline || request.url !== target.host) { socket.destroy(); return; }
    const upstream = net.connect(Number(target.port || 80), target.hostname);
    track(upstream);
    upstream.on('connect', () => {
      connected = true; server.emit('qa-websocket');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    address: `127.0.0.1:${server.address().port}`,
    connected: () => connected ? Promise.resolve() : once(server, 'qa-websocket', { signal: AbortSignal.timeout(15_000) }),
    disconnect() { offline = true; for (const socket of sockets) socket.destroy(); },
    reconnect() { offline = false; },
    close() { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
module.exports = { faultProxy };
