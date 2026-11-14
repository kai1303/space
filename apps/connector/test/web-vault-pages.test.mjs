import assert from 'node:assert/strict';
import test from 'node:test';
import { webVaultPages } from '../dist/web-vault-pages.js';

test('one Mac approval pages a full sorted snapshot, bound to actor, installation and connection', async () => {
  const items = Array.from({length: 121}, (_, i) => ({title: String(i), site:'https://linear.app', kind:'token'}));
  let approvals = 0;
  const pages = webVaultPages(async () => { approvals++; return {status:'listed', items, more:false}; });
  const request = {action:'list', actor:'owner', installation:'mac'};
  const signal = new AbortController().signal;
  let result = await pages.dispatch(request, signal);
  const firstCursor = result.cursor;
  assert.ok(firstCursor);
  for (const change of [{actor:'other'}, {installation:'other'}, {action:'manage'}]) {
    assert.deepEqual(await pages.dispatch({...request, cursor:firstCursor, ...change}, signal), {status:'unavailable'});
  }
  const received = [...result.items];
  while (result.more) {
    result = await pages.dispatch({...request, cursor:result.cursor}, signal);
    received.push(...result.items);
  }
  assert.deepEqual(received, items);
  assert.equal(approvals, 1);
  assert.deepEqual(await pages.dispatch({...request, cursor:firstCursor}, signal), {status:'unavailable'});
  const next = await pages.dispatch(request, signal);
  pages.clear();
  assert.deepEqual(await pages.dispatch({...request, cursor:next.cursor}, signal), {status:'unavailable'});
});
