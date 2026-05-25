import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TangleIframeProvider } from '@tangle-network/blueprint-ui/iframe';

import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      One provider at the root. `appId` identifies this blueprint to the
      parent dapp. In production (embedded by Tangle Cloud) the SDK detects
      the parent and bridges the wallet + service context. Standalone
      (localhost / direct visit) it falls into dev mode — same hooks, no
      parent — so this exact build is iterable without the dapp running.
    */}
    {/*
      Local dev: `auto` lets the app run standalone (dev mode) against the
      simulate path. Production: force `bridge` so a standalone visit can't
      fall into dev mode — it shows the "open from Tangle Cloud" gate instead
      of faking inference. Embedded by the dapp, `bridge` is what we want anyway.
    */}
    <TangleIframeProvider
      appId="llm-inference"
      mode={import.meta.env.DEV ? 'auto' : 'bridge'}
    >
      <App />
    </TangleIframeProvider>
  </StrictMode>,
);
