const providers = require('./providers.cjs');

function spaceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A Space web URL is required.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('Use an HTTPS Space URL, or HTTP on localhost for development, without embedded credentials.');
  }
  if (url.pathname === '/') url.pathname = '/chat';
  return url.href;
}

function navigationAction(value, configuredUrl) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'deny';
    if (['https:', 'http:'].includes(url.protocol)) {
      return url.origin === new URL(configuredUrl).origin ? 'internal' : 'external';
    }
    if (url.protocol === 'mailto:') return 'external';
  } catch {}
  return 'deny';
}

function isAssetDownload(value, configuredUrl) {
  if (navigationAction(value, configuredUrl) !== 'internal') return false;
  return /^\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/download$/i.test(new URL(value).pathname);
}

function isThreadWindow(value, configuredUrl) {
  if (navigationAction(value, configuredUrl) !== 'internal') return false;
  const url = new URL(value);
  return /^\/c\/[A-Za-z0-9_-]{21}[AQgw]\/thread\/[A-Za-z0-9_-]{21}[AQgw]$/.test(url.pathname)
    && url.search === '?threadWindow=1' && !url.hash;
}

module.exports = { spaceUrl, navigationAction, isAssetDownload, isThreadWindow };

function mediaPermissionAllowed(permission, origin, configuredUrl, mediaTypes = []) {
  return permission === 'media' && navigationAction(origin, configuredUrl) === 'internal'
    && Array.isArray(mediaTypes) && mediaTypes.every(type => ['audio', 'video'].includes(type));
}
module.exports.mediaPermissionAllowed = mediaPermissionAllowed;

function desktopHandoff(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return;
    const link = new URL(value);
    const origin = link.searchParams.get('origin');
    const workspace = link.searchParams.get('workspace');
    const provider = link.searchParams.get('provider');
    if (link.protocol !== 'space-desktop:' || link.host !== 'connect' || link.username || link.password || link.pathname || link.hash
      || link.searchParams.size !== 3 || !/^[a-zA-Z0-9_-]{1,100}$/.test(workspace || '') || !providers.has(provider)) return;
    const target = new URL(spaceUrl(origin));
    if (target.origin !== origin) return;
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(workspace)) {
      const key = Buffer.from(workspace.replaceAll('-', ''), 'hex').toString('base64url');
      target.pathname = '/w/' + (/^[a-z0-9-]+$/.test(key) ? '~' : '') + key;
    } else target.searchParams.set('workspace', workspace);
    target.searchParams.set('connectProvider', provider);
    return target;
  } catch { return; }
}
module.exports.desktopHandoff = desktopHandoff;
