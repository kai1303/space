import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: {
    '/mcp': { target: 'http://127.0.0.1:3000', xfwd: true },
    '/v1': { target: 'http://127.0.0.1:3000', xfwd: true },
    '/socket.io': { target: 'http://127.0.0.1:3000', xfwd: true, ws: true },
  } },
});
