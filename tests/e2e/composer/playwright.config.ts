import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  use: {baseURL:'http://127.0.0.1:4186'},
  webServer: {
    command:'pnpm exec vite --host 127.0.0.1 --port 4186 --strictPort',
    cwd:fileURLToPath(new URL('../../../apps/web/',import.meta.url)),
    url:'http://127.0.0.1:4186',
  },
});
