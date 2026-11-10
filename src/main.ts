/**
 * FormSathi entry point.
 *
 * Boot order matters and is deliberate:
 *   1. settings from IndexedDB          (so DEMO MODE is right before any call)
 *   2. vault presence / silent unlock    (so the first form can pre-fill)
 *   3. capability probe                  (so the first badge is truthful)
 *   4. shell render                      (fast — Firebase is not awaited)
 *   5. Firebase + service worker + queue (all deferred, none blocking)
 *
 * Nothing in 4–5 can throw into the user's face: a broken Firebase config still
 * gives a working offline form-filler.
 */

import './styles.css';
import { startShell } from './ui/shell';
import { boot } from './store/app';
import { toast } from './ui/dom';
import { registerVerifyRunner } from './services/verify';
import { loadSession, saveSession } from './services/sessions';
import { startSyncLoop, registerRunner } from './services/sync';
import { refreshPending, state } from './store/app';
import { syncSessionMetadata, currentUid } from './services/firebase';
import { refreshCapability } from './ai/router';

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing from index.html');

  // 1–3: state first, in parallel where safe.
  await boot();

  // 4: paint the shell before anything networked.
  startShell(root);

  // 5a: offline queue runners. These are what make step 4 survive airplane mode.
  registerVerifyRunner(loadSession, (sessionId, result) => {
    const issues = result.verdicts.filter((v) => v.status !== 'ok').length;
    toast(
      issues > 0
        ? `Net wapas aaya — cloud verify chal gaya. ${issues} field par dhyan dein.`
        : 'Net wapas aaya — cloud verify chal gaya, sab theek ✓',
      { tone: issues > 0 ? 'warn' : 'success', ms: 5000 },
    );
    void refreshPending();
    // Also re-save so any screen reading the session picks up the verdicts.
    void loadSession(sessionId).then((s) => (s ? saveSession(s, true) : undefined));
  });

  registerRunner('session_sync', async (task) => {
    const session = await loadSession(task.sessionId);
    const uid = currentUid();
    if (!session || !uid) return true;
    return syncSessionMetadata(session, uid);
  });

  startSyncLoop(() => void refreshPending());

  // 5b: service worker — offline-first app shell.
  // NOTE: boot() awaits IndexedDB, which can easily outrun the window 'load'
  // event. Attaching a 'load' listener here would then never fire and the app
  // would silently lose its offline shell — so check readyState first.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const registerSw = () => {
      void navigator.serviceWorker
        .register(new URL('sw.js', document.baseURI).pathname, { scope: './' })
        .then((reg) => {
          // Nudge an update into place on the next visit.
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            w?.addEventListener('statechange', () => {
              if (w.state === 'installed' && navigator.serviceWorker.controller) {
                toast('Naya version aa gaya — agli baar khulne par lag jayega', { tone: 'info' });
              }
            });
          });
        })
        .catch(() => {
          /* SW is a bonus; the app works without it */
        });
    };
    if (document.readyState === 'complete') registerSw();
    else window.addEventListener('load', registerSw, { once: true });
  }

  // 5c: capability probe for real-mode badge truth (skipped in demo, where the
  // router simulates on-device anyway — but we still want the Device panel).
  if (!state.settings.demoMode) {
    void refreshCapability(true);
  }

  // A single, quiet install hint — never a modal, never repeated.
  maybeInstallHint();
}

function maybeInstallHint(): void {
  const KEY = 'install_hint_shown';
  if (localStorage.getItem(KEY)) return;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return;
  setTimeout(() => {
    toast(
      isIos
        ? 'Tip: Share → "Add to Home Screen" se FormSathi ko app ki tarah install karein.'
        : 'Tip: address bar ke install button se FormSathi ko app ki tarah install kar sakte hain.',
      { tone: 'info', ms: 6000 },
    );
    localStorage.setItem(KEY, '1');
  }, 9000);
}

main().catch((err) => {
  console.error('[boot]', err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<div class="screen"><h1>App shuru nahi ho paya</h1>
      <p class="muted mt-8">${String(err?.message ?? err)}</p>
      <button class="btn btn-primary mt-16" onclick="location.reload()">Dobara kholein</button></div>`;
  }
});
