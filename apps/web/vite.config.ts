import { defineConfig } from 'vite';

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
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            // Preserve strict origin checks through the development-only proxy.
            // Untrusted origins are left intact and rejected by the API.
            if (request.headers.host === '127.0.0.1:5173' && request.headers.origin === 'http://127.0.0.1:5173') outgoing.setHeader('origin', 'http://127.0.0.1:3210');
          });
        },
      },
    },
  },
  preview: { host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
