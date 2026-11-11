import { serverConfig } from './config';

it('accepts an https origin and normalizes it', () => {
  expect(serverConfig('https://Space.Example.com/', false)).toEqual({ baseUrl: 'https://space.example.com' });
  expect(serverConfig('https://space.example.com:443', false)).toEqual({ baseUrl: 'https://space.example.com' });
});

it('allows http only in development', () => {
  expect(serverConfig('http://192.168.1.20:3000', true)).toEqual({ baseUrl: 'http://192.168.1.20:3000' });
  expect(() => serverConfig('http://192.168.1.20:3000', false)).toThrow('https');
});

it('rejects a missing value, a path or credentials', () => {
  expect(() => serverConfig(undefined, true)).toThrow('EXPO_PUBLIC_SPACE_URL');
  expect(() => serverConfig('https://space.example.com/api', false)).toThrow('EXPO_PUBLIC_SPACE_URL');
  expect(() => serverConfig('https://user:pw@space.example.com', false)).toThrow('EXPO_PUBLIC_SPACE_URL');
});
