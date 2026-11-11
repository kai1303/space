import type { CapacitorConfig } from '@capacitor/cli';
import { serverUrl } from './server-url.ts';

// Read at `cap sync` time and copied into the native projects (those copies are gitignored).
const server = serverUrl(process.env.SPACE_URL);

const config: CapacitorConfig = {
  appId: 'dev.space.app',
  appName: 'Space',
  webDir: 'www',
  // The web app pads itself with env(safe-area-inset-*), so the web view runs edge to edge.
  server: { url: server.url, cleartext: server.cleartext, errorPath: 'offline.html' },
};

export default config;
