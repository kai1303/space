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

module.exports = { spaceUrl, navigationAction, isAssetDownload };

function mediaPermissionAllowed(permission, origin, configuredUrl, mediaTypes = []) {
  return permission === 'media' && navigationAction(origin, configuredUrl) === 'internal'
    && Array.isArray(mediaTypes) && mediaTypes.every(type => ['audio', 'video'].includes(type));
}
module.exports.mediaPermissionAllowed = mediaPermissionAllowed;
