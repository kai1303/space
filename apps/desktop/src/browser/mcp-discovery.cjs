const { parse } = require('tldts');

const known = new Map([
  ['github.com', { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' }],
  ['linear.app', { name: 'Linear', url: 'https://mcp.linear.app/mcp' }],
]);
const maxBytes = 256 * 1024;

function applicationDomain(address) {
  if (!URL.canParse(address)) return;
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return;
  const parsed = parse(url.hostname, { allowPrivateDomains: true });
  if (parsed.isIcann && parsed.domain && !parsed.isPrivate) return parsed.domain;
}

function registeredSite(domain, entries) {
  const namespace = domain.split('.').reverse().join('.');
  for (const { server, _meta } of entries) {
    const publication = _meta?.['io.modelcontextprotocol.registry/official'];
    if (!publication?.isLatest || publication.status !== 'active' || server?.name?.split('/')[0] !== namespace) continue;
    for (const remote of server.remotes ?? []) {
      if (remote.type !== 'streamable-http' || typeof remote.url !== 'string' || remote.url.length > 2000 ||
          /[{}?#]/.test(remote.url) || applicationDomain(remote.url) !== domain) continue;
      if (remote.headers?.some(header => header.isRequired && header.name?.toLowerCase() !== 'authorization')) continue;
      return { name: server.title?.trim().slice(0, 100) || domain, url: new URL(remote.url).href };
    }
  }
}

async function discoverMcp(domain, fetcher, signal) {
  if (known.has(domain)) return known.get(domain);
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.search = new URLSearchParams({ search: domain.split('.').reverse().join('.') + '/', version: 'latest', limit: '25' });
  const response = await fetcher(url.href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal });
  if (!response.ok) throw new Error('MCP registry unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('MCP registry response is too large');
    chunks.push(chunk);
  }
  return registeredSite(domain, JSON.parse(Buffer.concat(chunks).toString()).servers);
}

module.exports = { applicationDomain, discoverMcp };
