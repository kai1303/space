import type { CapacitorConfig } from '@capacitor/cli';
import { serverUrl } from './server-url.ts';

// Read at `cap sync` time and copied into the native projects (those copies are gitignored).
const server = serverUrl(process.env.SPACE_URL, { release: process.env.SPACE_RELEASE === '1' });

const config: CapacitorConfig = {
  appId: 'dev.space.app',
  appName: 'Space',
  webDir: 'www',
  // Matches the web app's chrome, so any edge the web view leaves uncovered blends with the tab bar.
  backgroundColor: '#350d36',
  // The web app pads itself with env(safe-area-inset-*), so the web view runs edge to edge.
  server: { url: server.url, cleartext: server.cleartext, errorPath: 'offline.html' },
  plugins: {
    // Shrink the web view above the keyboard, so 100dvh layouts keep the composer in sight.
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    // Light status bar text over the web view's dark chrome.
    StatusBar: { style: 'DARK', overlaysWebView: true },
    // Auto hide still runs if the page never loads (offline.html); the web app hides it sooner once it renders.
    SplashScreen: { launchAutoHide: true, launchShowDuration: 1500, backgroundColor: '#350d36', showSpinner: false },
  },
};

export default config;
