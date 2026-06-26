import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [UnoCSS(), react()],
  server: {
    port: 5173,
    headers: {
      'Content-Security-Policy':
        "frame-ancestors 'self' http://localhost:4300 https://cloud.tangle.tools https://develop.cloud.tangle.tools",
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
