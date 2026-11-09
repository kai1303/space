import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { liveReceipts } from './dist/live-receipts.js';

test('bounds concurrent samples, single-use reports and unfinished deliveries', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcomes = [], durations = [], reports = [];
  const io = new EventEmitter(), socket = new EventEmitter();
  socket.connected = true;
  socket.timeout = () => socket;
  socket.on('chat.receipt.confirmed', (clientId, reply) => reports.push({ clientId, reply }));
  const receipts = liveReceipts(io, { outcome: value => outcomes.push(value), duration: seconds => durations.push(seconds) }, () => false);
  const start = receipts.sender(socket);
  const samples = Array.from({ length: 8 }, (_, i) => start(String(i)));
  assert.equal(start('excess'), undefined);
  assert.deepEqual(outcomes, ['capacity']);

  const [ok, invalid, late, failed, duplicate] = samples;
  receipts.received([ok.id, ok.id]);
  assert.equal(reports.length, 1);
  reports[0].reply(null, 125);
  reports[0].reply(null, 3500);
  receipts.received([invalid.id, late.id]);
  reports[1].reply(null, Infinity);
  failed.finish('send_failed');
  duplicate.finish('duplicate');
  t.mock.timers.tick(15_000);
  reports[2].reply(null, 100);
  assert.deepEqual(durations, [0.125]);
  assert.deepEqual(outcomes, ['capacity', 'confirmed', 'invalid_report', 'send_failed', 'duplicate', 'timeout', 'timeout', 'timeout', 'timeout']);

  const reconnect = start('disconnect');
  socket.emit('disconnect');
  receipts.received([reconnect.id]);
  assert.equal(outcomes.at(-1), 'disconnected');
  assert.equal(reports.length, 3);
});
