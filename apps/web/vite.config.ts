import { defineConfig } from 'vite';
import type { ClientRequest, IncomingMessage } from 'node:http';

export default defineConfig({
  // Vite's automatic JSX transform does not need another framework plugin.
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const rewriteOrigin = (outgoing: ClientRequest, request: IncomingMessage) => {
            // Preserve strict origin checks through the development-only proxy.
            // Untrusted origins are left intact and rejected by the API.
            if (request.headers.host === '127.0.0.1:5173' && request.headers.origin === 'http://127.0.0.1:5173') outgoing.setHeader('origin', 'http://127.0.0.1:3210');
          };
          proxy.on('proxyReq', rewriteOrigin);
          proxy.on('proxyReqWs', rewriteOrigin);
        },
      },
    },
  },
  preview: { host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
