// The shell loads the Space web app from its own server, so sign-in cookies and Origin checks work unchanged.
export const DEFAULT_URL = 'http://127.0.0.1:5173/chat';

export function serverUrl(value: string | undefined): { url: string; cleartext: boolean } {
  let parsed: URL;
  try { parsed = new URL(value?.trim() || DEFAULT_URL); }
  catch { throw new Error('SPACE_URL must be a full web address such as https://space.example.com'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('SPACE_URL must be an http or https address without credentials');
  }
  // Plain http is for local development only. Release builds must use https.
  return { url: parsed.href, cleartext: parsed.protocol === 'http:' };
}
