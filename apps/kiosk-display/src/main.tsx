import { render } from 'preact';
import { App } from './app.tsx';
import { installPreviewListener, isPreview } from './data/preview.ts';
import { installRecovery } from './data/recovery.ts';

// Preview (the admin app's pratonton): listen for the host's token before anything renders, and stay out of the
// service worker and the self-reload logic, which belong to a paired display.
const preview = isPreview();
if (preview) installPreviewListener();

const root = document.getElementById('app');
if (root) render(<App />, root);

// Self-healing for the unattended TV: production only (inert in Vitest and the dev server).
if (import.meta.env.PROD && !preview) installRecovery({ reload: () => location.reload() });

// Offline app shell: production builds only (never Vitest or the dev server).
if (import.meta.env.PROD && !preview && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('service worker registration failed', error);
    });
  } catch (error) {
    console.error('service worker registration failed', error);
  }
}
