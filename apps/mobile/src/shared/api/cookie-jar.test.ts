import { applySetCookie, cookieHeader } from './cookie-jar';

it('reads several cookies from one joined header', () => {
  const jar = applySetCookie({}, 'better-auth.session_token=jwt1; Max-Age=900; Path=/; HttpOnly, space.refresh=r1; Expires=Wed, 11 Dec 2026 07:28:00 GMT; Path=/v1/auth');
  expect(jar).toEqual({ 'better-auth.session_token': 'jwt1', 'space.refresh': 'r1' });
});

it('replaces and removes cookies', () => {
  expect(applySetCookie({ a: '1', b: '2', c: '3' }, 'a=9; Path=/, b=; Path=/, c=3; Max-Age=0')).toEqual({ a: '9' });
});

it('ignores malformed entries and leaves the input unchanged', () => {
  const input = { a: '1' };
  expect(applySetCookie(input, '=x, novalue')).toEqual({ a: '1' });
  expect(input).toEqual({ a: '1' });
});

it('builds a Cookie header', () => {
  expect(cookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
  expect(cookieHeader({})).toBe('');
});
