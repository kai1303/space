import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: {
    '/mcp': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true },
    '/v1': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true },
    '/socket.io': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true, ws: true },
  } },
});
