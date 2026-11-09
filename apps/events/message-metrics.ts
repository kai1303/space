import { createServer } from 'node:http';
import type { EventBridge } from './bridge.js';

export function startMessageMetrics(bridge: EventBridge, address = { host: '0.0.0.0', port: 9464 }) {
  if (bridge.messagesCreated === undefined) return;
  const listener = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }).end(
      '# HELP space_chat_messages_created_total Committed message inserts processed by the event bridge.\n' +
      '# TYPE space_chat_messages_created_total counter\n' +
      `space_chat_messages_created_total ${bridge.messagesCreated}\n`,
    );
  });
  listener.maxConnections = 4;
  listener.setTimeout(5000);
  listener.on('error', () => console.warn('metrics_listener_unavailable'));
  return listener.listen(address);
}
