const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boundedDiskProbe, jetstreamMetrics, scrape } = require('./infra-metrics.cjs');

function brokerReport() {
  const consumer = {
    name: 'remote-workers', num_pending: 2, num_ack_pending: 1, num_redelivered: 1,
    delivered: { consumer_seq: 12 }, ack_floor: { consumer_seq: 8 },
  };
  return {
    storage: 64, config: { max_storage: 1024 },
    account_details: [{ id: '$G', stream_detail: [
      { name: 'SPACE_PUBLIC_WORK', consumer_detail: [consumer, { name: 'local-private-user' }] },
      { name: 'SPACE_PRIVATE_WORK', consumer_detail: [{ ...consumer, name: 'navigator-workers' }] },
    ] }],
  };
}

test('observes backlog and the contiguous ACK floor on configured consumers only', () => {
  const result = jetstreamMetrics(brokerReport(), 'SPACE_PUBLIC');
  const labels = '{stream="WORK",consumer="remote-workers"}';
  for (const [key, n] of Object.entries({ present: 1, pending: 2, ack_pending: 1, redelivered: 1, ack_floor: 8 })) {
    assert.ok(result.includes(`space_jetstream_consumer_${key}${labels} ${n}\n`));
  }
  assert.match(result, /space_jetstream_consumer_present\{stream="WORK",consumer="navigator-workers"\} 0/);
  assert.doesNotMatch(result, /SPACE_PRIVATE|local-private-user|channel-huddles/);
  assert.doesNotMatch(result, /space_jetstream_consumer_pending\{stream="WORK",consumer="navigator-workers"/);
});

test('a failed source drops its metrics, emits no raw error, and preserves other sources', async () => {
  const malformed = brokerReport();
  delete malformed.account_details[0].stream_detail[0].consumer_detail[0].num_pending;
  const result = await scrape({
    nats: () => jetstreamMetrics(malformed, 'SPACE_PUBLIC'), disk: () => 'space_volume_sample 1\n',
    api: () => { throw new Error('sensitive transport details'); },
  });
  assert.match(result, /space_infra_source_up\{source="nats"\} 0/);
  assert.match(result, /space_infra_source_up\{source="api"\} 0/);
  assert.match(result, /space_api_ready 0/);
  assert.match(result, /space_volume_sample 1\nspace_infra_source_up\{source="disk"\} 1/);
  assert.doesNotMatch(result, /space_jetstream|sensitive/);
});

test('a stuck disk times out without queueing more I/O and subsequent scrapes recover', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  let attempts = 0;
  const probe = boundedDiskProbe(async () => { attempts++; return pending; }, 5);
  await assert.rejects(probe(), /timeout/);
  await assert.rejects(probe(), /pending/);
  assert.equal(attempts, 1);
  complete('recovered');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await probe(), 'recovered');
  assert.equal(attempts, 2);
});
