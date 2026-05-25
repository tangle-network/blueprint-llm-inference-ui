import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The Tangle Cloud dapp embeds this app in a sandboxed iframe. CSP
    // frame-ancestors is set at deploy time (CF Pages / Netlify headers);
    // in dev we allow the local dapp origin to embed us.
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
