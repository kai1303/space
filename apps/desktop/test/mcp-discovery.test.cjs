const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applicationDomain, discoverMcp } = require('../src/browser/mcp-discovery.cjs');

test('only looks up public application domains', () => {
  assert.equal(applicationDomain('https://team.service.co.uk/private?token=secret'), 'service.co.uk');
  for (const url of ['http://example.com', 'https://localhost', 'https://10.1.1.1', 'https://org.github.io', 'https://dev.internal', 'https://example.com:8443', 'https://a:b@example.com']) {
    assert.equal(applicationDomain(url), undefined, url);
  }
});

test('requires an active domain publisher and a compatible provider-hosted endpoint', async () => {
  const official = { status: 'active', isLatest: true };
  const base = { name: 'com.example/mcp', title: 'Example', remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp' }] };
  const entry = (server, status = official) => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': status } });
  const entries = [
    entry({ ...base, name: 'io.github.someone/mcp', websiteUrl: 'https://example.com' }),
    entry({ ...base, name: 'com.example.other/mcp' }),
    entry(base, { ...official, status: 'deleted' }),
    entry(base, { ...official, isLatest: false }),
    ...[
      { type: 'sse', url: 'https://example.com/sse' },
      { type: 'streamable-http', url: 'https://example.com.evil.com/mcp' },
      { type: 'streamable-http', url: 'https://example.com/{tenant}' },
      { type: 'streamable-http', url: 'https://example.com/mcp', headers: [{ name: 'x-api-key', isRequired: true }] },
    ].map(remote => entry({ ...base, remotes: [remote] })),
  ];
  const fetcher = async (address, options) => {
    assert.equal(new URL(address).searchParams.get('search'), 'com.example/');
    assert.equal(options.credentials, 'omit');
    return Response.json({ servers: entries });
  };
  assert.equal(await discoverMcp('example.com', fetcher), undefined);
  entries.push(entry(base));
  assert.deepEqual(await discoverMcp('example.com', fetcher), { name: 'Example', url: 'https://api.example.com/mcp' });
});
