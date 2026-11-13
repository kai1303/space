import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const speechRuntime = dirname(createRequire(import.meta.url).resolve('@huggingface/transformers'));
export default defineConfig({
  resolve: {alias: {'space-dictation-runtime':speechRuntime}},
  server: { proxy: {
    '/mcp': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true },
    '/v1': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true },
    '/socket.io': { target: process.env.SPACE_API_URL ?? 'http://127.0.0.1:3000', xfwd: true, ws: true },
  } },
});
