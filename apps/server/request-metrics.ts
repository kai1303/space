import { once } from 'node:events';
import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry } from '@prometheus-io/client';
import { receiptOutcomes, type ReceiptMetrics } from './live-receipts.js';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export interface MonitoringListener { host: string; port: number }

export function registerRequestMetrics(app: FastifyInstance, address: MonitoringListener): ReceiptMetrics {
  const registry = new Registry();
  const requests = new Counter({
    name: 'space_api_http_requests_total',
    help: 'Completed API HTTP requests.',
    labelNames: ['method', 'route', 'status_class'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'space_api_http_request_duration_seconds',
    help: 'Time to complete an API HTTP response in seconds.',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const confirmedReceipt = new Histogram({
    name: 'space_chat_live_confirmed_receipt_seconds',
    help: 'Seconds on the sending browser from message.send submission to first confirmed live receipt by another user.',
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
    registers: [registry],
  });
  const receiptSamples = new Counter({
    name: 'space_chat_live_receipt_samples_total',
    help: 'Terminal outcomes for live receipt measurement attempts.',
    labelNames: ['outcome'],
    registers: [registry],
  });
  // Give the first observed outcome a zero baseline for Prometheus increase().
  for (const outcome of receiptOutcomes) receiptSamples.inc({ outcome }, 0);
  app.addHook('onResponse', (request, reply, done) => {
    const method = methods.has(request.method) ? request.method : 'OTHER';
    const route = request.routeOptions.url ?? 'unmatched';
    const code = reply.statusCode;
    const status = code >= 100 && code < 600 ? Math.floor(code / 100) + 'xx' : 'other';
    requests.inc({ method, route, status_class: status });
    const elapsedMs = reply.elapsedTime;
    duration.observe({ method, route }, elapsedMs / 1000);
    const probe = (method === 'GET' || method === 'HEAD') && (route === '/healthz' || route === '/readyz');
    if (!probe) app.log.info({ httpMethod: method, statusCode: code, durationMs: Math.round(elapsedMs) }, 'http_request_completed');
    done();
  });

  const listener = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await registry.metrics();
      response.writeHead(200, { 'content-type': registry.contentType }).end(body);
    } catch {
      response.writeHead(503).end();
    }
  });
  listener.maxConnections = 4;
  listener.setTimeout(5000);
  const warnUnavailable = () => app.log.warn('metrics_listener_unavailable');
  app.addHook('onReady', async () => {
    // A port conflict disables scraping without preventing API startup.
    try {
      listener.listen(address);
      await once(listener, 'listening');
      listener.on('error', warnUnavailable);
    } catch { warnUnavailable(); }
  });
  app.addHook('onClose', async () => {
    if (!listener.listening) return;
    await new Promise<void>(resolve => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
  });
  return { duration: seconds => confirmedReceipt.observe(seconds), outcome: outcome => receiptSamples.inc({ outcome }) };
}
