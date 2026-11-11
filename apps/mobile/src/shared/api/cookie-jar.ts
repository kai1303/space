export type Cookies = Record<string, string>;

// Split a joined Set-Cookie header only where a new `name=` starts.
const entries = (header: string) => header.split(/,\s*(?=[^;,\s=]+=)/);

export function applySetCookie(jar: Cookies, header: string | null): Cookies {
  if (!header) return jar;
  const next = { ...jar };
  for (const entry of entries(header)) {
    const [pair = '', ...attributes] = entry.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(attribute => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(attribute));
    if (!value || expired) delete next[name];
    else next[name] = value;
  }
  return next;
}

export function cookieHeader(jar: Cookies): string {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}
