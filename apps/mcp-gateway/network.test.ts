import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
test('outbound network policy rejects private, mapped and special destinations', async () => {
  assert.ok(existsSync('network.ts'), 'outbound network policy exists');
  const { isPublicAddress, resolvePublic } = await import('./network.js');
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(
    resolvePublic('https://example.com/mcp', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /blocked/,
  );
  await assert.rejects(resolvePublic('https://127.0.0.1/mcp'), /blocked/);
  assert.deepEqual(await resolvePublic('https://example.com/mcp', async () => [{ address: '8.8.8.8', family: 4 }]), {
    address: '8.8.8.8',
    family: 4,
  });
});

test('one DNS snapshot is used and redirects cannot escape the approved endpoint', async () => {
  const { pinnedFetch } = await import('./network.js');
  const { Response } = await import('undici');
  let resolutions = 0,
    requests = 0;
  const network = await pinnedFetch('https://example.com/mcp', new AbortController().signal, {
    resolve: async () => {
      resolutions++;
      return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    },
    fetch: async (_input, init) => {
      requests++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } });
    },
  });
  try {
    await assert.rejects(network.fetch('https://example.com/mcp'), /mcp_redirect_blocked/);
    await assert.rejects(network.fetch('https://example.com/mcp'), /mcp_redirect_blocked/);
    await assert.rejects(network.fetch('https://127.0.0.1/admin'), /mcp_destination_changed/);
    assert.equal(resolutions, 1);
    assert.equal(requests, 2);
  } finally {
    await network.close();
  }
});
test('the network boundary caps cumulative bytes before the SDK parses a response', async () => {
  const { pinnedFetch } = await import('./network.js');
  const { Response } = await import('undici');
  const network = await pinnedFetch('https://example.com/mcp', new AbortController().signal, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => new Response('x'.repeat(1048577)),
  });
  try {
    const response = await network.fetch('https://example.com/mcp');
    await assert.rejects(response.text(), /mcp_response_too_large/);
  } finally {
    await network.close();
  }
});
