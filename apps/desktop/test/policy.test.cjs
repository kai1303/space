const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spaceUrl, navigationAction, isAssetDownload } = require('../src/policy.cjs');

test('accepts HTTPS deployments and normalizes the home route to chat', () => {
  assert.equal(spaceUrl('https://space.example.com'), 'https://space.example.com/chat');
  assert.equal(spaceUrl('https://space.example.com/chat?channel=123'), 'https://space.example.com/chat?channel=123');
});

test('only recognized same-origin asset downloads use the native downloader', () => {
  const base = 'https://space.example.com/chat';
  const path = '/v1/assets/00000000-0000-4000-8000-000000000001/download';
  assert.equal(isAssetDownload(new URL(path, base).href, base), true);
  for (const value of [`https://evil.test${path}`, `${base}/download`, 'https://space.example.com/v1/assets/not-an-id/download', `https://user:secret@space.example.com${path}`, 'file:///download']) {
    assert.equal(isAssetDownload(value, base), false);
  }
});

test('allows HTTP only on explicit loopback hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(spaceUrl(`http://${host}:5173`), `http://${host}:5173/chat`);
  }
  for (const value of ['http://space.example.com', 'http://localhost.evil.test', 'file:///tmp/app.html', 'javascript:alert(1)', 'https://user:secret@space.example.com', '', null]) {
    assert.throws(() => spaceUrl(value));
  }
});

test('only the configured origin can navigate inside Space', () => {
  const origin = 'https://space.example.com/chat';
  assert.equal(navigationAction('https://space.example.com/channel/1', origin), 'internal');
  for (const value of ['https://space.example.com.evil.test', 'https://space.example.com:444/chat', 'https://example.com', 'mailto:hello@example.com']) {
    assert.equal(navigationAction(value, origin), 'external');
  }
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'space://run', 'https://user:password@space.example.com', 'not a URL']) {
    assert.equal(navigationAction(value, origin), 'deny');
  }
});

test('media permissions are confined to the configured origin and audio/video capture', () => {
  const { mediaPermissionAllowed } = require('../src/policy.cjs');
  const base='https://space.example.com/chat';
  assert.equal(mediaPermissionAllowed('media', 'https://space.example.com', base, ['audio','video']), true);
  for(const [permission,origin,types] of [['media','https://evil.test',['audio']],['display-capture','https://space.example.com',['video']],['media','https://space.example.com',['display']],['media','null',['audio']]])
    assert.equal(mediaPermissionAllowed(permission,origin,base,types),false);
});
