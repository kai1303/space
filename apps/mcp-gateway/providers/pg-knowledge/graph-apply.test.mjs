import test from 'node:test';
import assert from 'node:assert/strict';
import { fillChannelText } from './graph-apply.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A fake knowledge database holding channel rows, and a fake Space database answering by id.
function fakes(stored, space) {
  const reads = [];
  const index = { async query(text, values) {
    if (/^SELECT id FROM kb\.m_channels/.test(text)) {
      const [after, limit] = values;
      const rows = stored.filter(r => (r.topic === null || r.description === null) && r.id > after).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, limit);
      return { rows: rows.map(r => ({ id: r.id })) };
    }
    if (/^UPDATE kb\.m_channels/.test(text)) {
      const [ids, topics, descriptions] = values;
      let rowCount = 0;
      ids.forEach((key, i) => { const row = stored.find(r => r.id === key); if (row) { row.topic ??= topics[i]; row.description ??= descriptions[i]; rowCount++; } });
      return { rowCount };
    }
    throw new Error('unexpected index query: ' + text);
  } };
  const source = { async query(_text, [ids]) {
    reads.push(ids.length);
    return { rows: space.filter(c => ids.includes(c.id)) };
  } };
  return { index, source, reads };
}

test('fillChannelText copies topic and description only into rows that lack them, in bounded pages', async () => {
  const stored = [
    { id: id(1), topic: null, description: null },
    { id: id(2), topic: 'Kept', description: 'Kept too' },
    { id: id(3), topic: null, description: null },
    { id: id(4), topic: null, description: null },   // gone from Space: stays NULL, the loop still ends
  ];
  const space = [
    { id: id(1), topic: 'Launch', description: '' },
    { id: id(2), topic: 'New', description: 'New' },
    { id: id(3), topic: '', description: 'Billing questions' },
  ];
  const { index, source, reads } = fakes(stored, space);
  assert.equal(await fillChannelText(index, source, 2), 2);
  assert.deepEqual(stored.map(r => [r.topic, r.description]), [['Launch', ''], ['Kept', 'Kept too'], ['', 'Billing questions'], [null, null]]);
  assert.deepEqual(reads, [2, 1], 'pages of at most 2 ids');
  assert.equal(await fillChannelText(index, source, 2), 0, 'a second start copies nothing new');
});

test('attachment CDC reconciles live and previously projected files for a post even when it has no indexed text', async () => {
  const { attachmentChanges } = await import('./graph-apply.mjs');
  const message = id(2), channel = id(3), retained = id(4), detached = id(5), renamed = id(6);
  const row = { id: retained, message_id: message, channel_id: channel, name: 'kept.txt' };
  const source = { async query(text) {
    if (text.includes('unnest')) return { rows: [{ id: retained, message_id: message }] };
    return { rows: [row, { ...row, id: renamed, name: 'latest.txt' }] };
  } };
  const index = { async query() { return { rows: [{ id: retained, message_id: message }, { id: detached, message_id: message }] }; } };
  const changes = await attachmentChanges(index, source, [
    { table: 'messages', row: { id: message, channel_id: channel }, lsn: '0/11' },
    { table: 'assets', row: { id: renamed }, lsn: '0/32' },
    { table: 'assets', row: { id: retained }, lsn: '0/10' },
  ]);
  assert.deepEqual(new Map(changes.map(c => [c.row.id, [c.op, c.lsn, c.row.name]])), new Map([
    [retained, ['insert', '0/11', 'kept.txt']], [detached, ['delete', '0/11', undefined]], [renamed, ['insert', '0/32', 'latest.txt']],
  ]));
});
