import type { CapacitorConfig } from '@capacitor/cli';
import { serverUrl } from './server-url.ts';

// Read at `cap sync` time and copied into the native projects (those copies are gitignored).
const server = serverUrl(process.env.SPACE_URL);

const config: CapacitorConfig = {
  appId: 'dev.space.app',
  appName: 'Space',
  webDir: 'www',
  server: { url: server.url, cleartext: server.cleartext, errorPath: 'offline.html' },
  // Keep the web app below the status bar and above the home indicator.
  ios: { contentInset: 'always' },
};

export default config;
