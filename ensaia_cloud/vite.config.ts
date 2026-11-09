import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: false,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            if (request.headers.host) outgoing.setHeader('x-forwarded-host', request.headers.host);
          });
        },
      },
    },
  },
});
