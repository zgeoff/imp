import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// impd's API in development: a dev instance (scripts/dev.sh) publishes it on
// 7070 plus IMP_DEV_PORT_OFFSET
const impdUrl = `http://localhost:${String(7070 + Number(process.env['IMP_DEV_PORT_OFFSET'] ?? 0))}`;

// the Origin check compares the browser's host and port with the request's;
// changeOrigin would rewrite the Host header and fail it
const proxied = { target: impdUrl, changeOrigin: false };

export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/rpc': proxied,
      '/auth': proxied,
      '/exec': { ...proxied, ws: true },
    },
  },
});
