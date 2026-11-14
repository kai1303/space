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

test('encrypted Linear saves are bound to the Mac and owner, consumed once, and revoked on disconnect', async () => {
  const {CompactEncrypt, importSPKI} = await import('jose');
  const received = [];
  const item = {title:'Work', kind:'token', site:'https://linear.app'};
  const pages = webVaultPages(async request => { received.push(request); return {status:'saved', item}; });
  const base = {actor:'owner', installation:'mac'};
  const signal = new AbortController().signal;
  async function prepare() {
    const ready = await pages.dispatch({...base, action:'prepare-linear'}, signal);
    const key = await importSPKI(ready.publicKey, 'ECDH-ES');
    const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({title:'Work',token:'fixture-only'})))
      .setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',kid:ready.transfer}).encrypt(key);
    return {...base, action:'save-linear', transfer:ready.transfer, sealed};
  }
  const save = await prepare();
  for (const change of [{actor:'another'}, {installation:'another'}])
    assert.deepEqual(await pages.dispatch({...save, ...change}, signal), {status:'unavailable'});
  assert.deepEqual(await pages.dispatch(save, signal), {status:'saved', item});
  assert.deepEqual(await pages.dispatch(save, signal), {status:'unavailable'});
  const interrupted = await prepare();
  pages.clear();
  assert.deepEqual(await pages.dispatch(interrupted, signal), {status:'unavailable'});
  const changed = await prepare();
  const segments = changed.sealed.split('.');
  segments[3] = (segments[3][0] === 'A' ? 'B' : 'A') + segments[3].slice(1);
  assert.deepEqual(await pages.dispatch({...changed, sealed:segments.join('.')}, signal), {status:'unavailable'});
  assert.equal(received.length, 1);
  assert.equal(received[0].token,'fixture-only');
});

test('item details and write receipts are encrypted to the requesting browser', async () => {
  const {generateKeyPair, exportSPKI, compactDecrypt, importSPKI, CompactEncrypt} = await import('jose');
  const {publicKey,privateKey} = await generateKeyPair('ECDH-ES', {crv:'P-256'});
  const recipient = await exportSPKI(publicKey);
  const item = {id:'27cf1505-4792-47cd-8da6-bb9936515ebe',version:'27cf1505-4792-47cd-8da6-bb9936515ebf',kind:'login',title:'Account',site:'https://example.com',username:'test account'};
  const base = {actor:'owner', installation:'mac'};
  const signal = new AbortController().signal;
  const pages = webVaultPages(async request => {
    if (request.action === 'list-items') return {status:'listed',items:Array(9).fill(item),more:false};
    assert.deepEqual(request.change, change);
    return {status:'saved',item};
  });
  async function decode(response) {
    assert.equal(response.status,'encrypted');
    assert.equal(JSON.stringify(response).includes(item.username),false);
    return JSON.parse(new TextDecoder().decode((await compactDecrypt(response.sealed,privateKey)).plaintext));
  }
  const first = await pages.dispatch({...base,action:'list-items',publicKey:recipient},signal);
  const page = await decode(first);
  assert.equal(page.items.length,8);
  assert.deepEqual(await pages.dispatch({...base,action:'list',cursor:page.cursor},signal),{status:'unavailable'});
  assert.deepEqual((await decode(await pages.dispatch({...base,action:'list-items',publicKey:recipient,cursor:page.cursor},signal))).items,[item]);
  const change = {operation:'edit', ...item, secret:''};
  const ready = await pages.dispatch({...base,action:'prepare-item'},signal);
  const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({change,publicKey:recipient})))
    .setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',kid:ready.transfer}).encrypt(await importSPKI(ready.publicKey,'ECDH-ES'));
  const request = {...base,action:'change-item',transfer:ready.transfer,sealed};
  assert.deepEqual(await decode(await pages.dispatch(request,signal)),{status:'saved',item});
  assert.deepEqual(await pages.dispatch(request,signal),{status:'unavailable'});
});
