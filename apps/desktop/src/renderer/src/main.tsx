import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Browser harness.
 *
 * In Electron the preload has already installed `window.ucad`, so this is a
 * no-op. Opened as a plain web page (`npm run dev:web`) there is no preload,
 * so an in-memory fixture bridge is installed instead — which is what makes the
 * UI verifiable in a browser. See `./dev/fixture-bridge.ts`.
 *
 * The import is dynamic so the fixture never lands in the production bundle's
 * critical path, and the function returns `null` when the real bridge exists.
 */
async function installBridge(): Promise<void> {
  if (window.ucad) return;
  const { installFixtureBridge } = await import('./dev/fixture-bridge');
  installFixtureBridge();
}

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

installBridge().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
