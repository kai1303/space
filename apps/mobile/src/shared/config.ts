// React Native's URL class lacks most getters, so parse the origin directly.
const ORIGIN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?\/?$/;

export function serverConfig(
  value: string | undefined = process.env.EXPO_PUBLIC_SPACE_URL,
  development: boolean = __DEV__,
) {
  const match = value ? ORIGIN.exec(value.trim()) : null;
  if (!match) throw new Error('EXPO_PUBLIC_SPACE_URL must be a server origin such as https://space.example.com');
  const [, scheme, host, port = ''] = match;
  if (scheme !== 'https' && !development) throw new Error('EXPO_PUBLIC_SPACE_URL must use https outside development');
  const defaultPort = (scheme === 'https' && port === ':443') || (scheme === 'http' && port === ':80');
  // This must equal the server's own origin string, which Origin checks compare exactly.
  return { baseUrl: `${scheme}://${host!.toLowerCase()}${defaultPort ? '' : port}` };
}
