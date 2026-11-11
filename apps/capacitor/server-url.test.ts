import assert from 'node:assert/strict';
import test from 'node:test';
import { serverUrl } from './server-url.ts';

test('uses the given Space web address', () => {
  assert.deepEqual(serverUrl('https://space.example.com/chat'), { url: 'https://space.example.com/chat', cleartext: false });
});

test('allows http only for development and says so', () => {
  assert.deepEqual(serverUrl('http://127.0.0.1:5173/'), { url: 'http://127.0.0.1:5173/', cleartext: true });
});

test('defaults to the local web dev server', () => {
  assert.equal(serverUrl(undefined).url, 'http://127.0.0.1:5173/chat');
});

test('rejects other schemes and credentials', () => {
  assert.throws(() => serverUrl('file:///etc/passwd'), /SPACE_URL/);
  assert.throws(() => serverUrl('https://user:pw@space.example.com'), /SPACE_URL/);
  assert.throws(() => serverUrl('not a url'), /SPACE_URL/);
});
