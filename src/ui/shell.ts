/**
 * App shell: top bar, bottom nav, hash router, global status indicators.
 *
 * Routing is hash-based on purpose: it works on Firebase Hosting with zero
 * rewrite config, it is shareable, and - the real reason - the Android back
 * button behaves correctly in a standalone PWA.
 */

import { mount, h, onAction, toast, closeAllSheets } from './dom';
import { openRouterLog } from './routerLog';
import { openSettings } from './settings';
import { state, subscribe } from '../store/app';
import { routerState } from '../ai/router';
import { badge } from './badges';
import { renderHome } from './screens/home';
import { renderIntake } from './screens/intake';
import { renderInterview } from './screens/interview';
import { renderChecklist } from './screens/checklist';
import { renderVerify } from './screens/verify';
import { renderResult } from './screens/result';
import { renderVault } from './screens/vault';
import { renderHowItWorks } from './screens/howItWorks';

export type RouteName =
  | 'home'
  | 'intake'
  | 'interview'
  | 'checklist'
  | 'verify'
  | 'result'
  | 'vault'
  | 'how';

export interface Route {
  name: RouteName;
  sessionId?: string;
}

export const routes: { name: RouteName; label: string; icon: string; path: string }[] = [
  { name: 'home', label: 'Home', icon: '🏠', path: '#/' },
  { name: 'vault', label: 'Vault', icon: '🔐', path: '#/vault' },
  { name: 'how', label: 'How it works', icon: '💡', path: '#/how' },
];

let navEl: HTMLElement | null = null;
let appEl: HTMLElement | null = null;
let current: Route = { name: 'home' };
let cleanup: (() => void) | null = null;

export function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [rawName, ...rest] = hash.split('/');
  const name = (rawName || 'home') as RouteName;
  const sessionId = rest.join('/') || undefined;
  const known: RouteName[] = ['home', 'intake', 'interview', 'checklist', 'verify', 'result', 'vault', 'how'];
  if (!known.includes(name)) return { name: 'home' };
  return { name, sessionId };
}

export function navigate(path: string): void {
  if (location.hash === path) {
    void render();
    return;
  }
  location.hash = path;
}

export function go(name: RouteName, sessionId?: string): void {
  const path = name === 'home' ? '#/' : sessionId ? `#/${name}/${sessionId}` : `#/${name}`;
  navigate(path);
}

/** Screens that should hide the bottom nav (focused, full-screen flows). */
const NO_NAV: RouteName[] = ['interview', 'verify'];

export function topBar(): HTMLElement {
  const bar = h('div', { class: 'topbar' });
  const brand = h(
    'button',
    { class: 'row gap-8', style: 'background:none;border:0;padding:0;cursor:pointer', 'data-action': 'go-home' },
    h('span', { class: 'brand-mark' }, 'F'),
    h('span', { class: 'strong' }, 'FormSathi'),
  );
  const actions = h('div', { class: 'topbar-actions' });

  // Live status chips: offline / queued / demo. These are the three facts a
  // user (and a judge) needs at all times.
  const status = h('div', { class: 'row gap-4' });
  const renderStatus = () => {
    const chips: HTMLElement[] = [];
    const offlineNow = state.settings.simulatedOffline || !navigator.onLine;
    if (offlineNow) {
      const chip = h('span', { class: 'badge badge-offline badge-sm' });
      chip.innerHTML = `<span class="badge-ic">✈️</span><span class="badge-tx">Offline</span>`;
      chip.title = state.settings.simulatedOffline ? 'Demo offline mode on' : 'No internet';
      chips.push(chip);
    }
    if (state.pending > 0) {
      const chip = h('span', { class: 'badge badge-queued badge-sm' });
      chip.innerHTML = `<span class="badge-ic">⏳</span><span class="badge-tx">${state.pending} queued</span>`;
      chip.title = 'Cloud verify is queued - it will run when the network returns';
      chips.push(chip);
    }
    if (state.settings.demoMode) {
      const chip = h('span', { class: 'badge badge-demo badge-sm' });
      chip.innerHTML = `<span class="badge-ic">🧪</span><span class="badge-tx">Demo</span>`;
      chip.title = 'DEMO MODE: mock models, zero keys';
      chips.push(chip);
    }
    mount(status, ...chips);
  };
  renderStatus();
  subscribe(renderStatus);

  const routerBtn = h('button', {
    class: 'icon-btn',
    'data-action': 'open-router',
    title: 'Model Router log',
    'aria-label': 'Open Model Router log',
  });
  routerBtn.textContent = '🛰';

  const settingsBtn = h('button', {
    class: 'icon-btn',
    'data-action': 'open-settings',
    title: 'Settings',
    'aria-label': 'Open Settings',
  });
  settingsBtn.textContent = '⚙️';

  actions.append(status, routerBtn, settingsBtn);
  bar.append(brand, actions);

  onAction(bar, (action) => {
    if (action === 'go-home') go('home');
    if (action === 'open-router') openRouterLog();
    if (action === 'open-settings') openSettings();
  });

  return bar;
}

function renderNav(): HTMLElement {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main menu' });
  for (const r of routes) {
    const active = current.name === r.name || (r.name === 'home' && ['intake', 'interview', 'checklist', 'verify', 'result'].includes(current.name));
    const btn = h('button', {
      class: 'nav-item',
      'data-path': r.path,
      ...(active ? { 'aria-current': 'page' } : {}),
    });
    btn.innerHTML = `<span class="ic" aria-hidden="true">${r.icon}</span><span>${r.label}</span>`;
    btn.addEventListener('click', () => navigate(r.path));
    nav.append(btn);
  }
  return nav;
}

/** Mount a screen and manage its lifecycle. */
export async function render(): Promise<void> {
  if (!appEl) return;
  current = parseHash();

  // Dismiss any sheet left open by the previous screen.
  closeAllSheets();

  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  const screenHost = h('div');
  const bar = topBar();
  const showNav = !NO_NAV.includes(current.name);

  appEl.replaceChildren(bar, screenHost);
  document.body.classList.toggle('no-nav', !showNav);

  if (navEl) navEl.remove();
  if (showNav) {
    navEl = renderNav();
    document.body.append(navEl);
  }

  const opts = { sessionId: current.sessionId };
  try {
    switch (current.name) {
      case 'home':
        cleanup = await renderHome(screenHost);
        break;
      case 'intake':
        cleanup = await renderIntake(screenHost);
        break;
      case 'interview':
        cleanup = await renderInterview(screenHost, opts.sessionId);
        break;
      case 'checklist':
        cleanup = await renderChecklist(screenHost, opts.sessionId);
        break;
      case 'verify':
        cleanup = await renderVerify(screenHost, opts.sessionId);
        break;
      case 'result':
        cleanup = await renderResult(screenHost, opts.sessionId);
        break;
      case 'vault':
        cleanup = await renderVault(screenHost);
        break;
      case 'how':
        cleanup = await renderHowItWorks(screenHost);
        break;
      default:
        cleanup = await renderHome(screenHost);
    }
  } catch (err) {
    console.error('[route]', err);
    screenHost.replaceChildren(
      h(
        'div',
        { class: 'screen' },
        h('h1', {}, 'Something went wrong'),
        h('p', { class: 'muted mt-8' }, err instanceof Error ? err.message : String(err)),
        h(
          'button',
          { class: 'btn btn-primary mt-16', onclick: () => go('home') },
          'Back home',
        ),
      ),
    );
  }

  // Scroll to top on navigation (but not on in-screen re-renders).
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

export function startShell(root: HTMLElement): void {
  appEl = root;
  window.addEventListener('hashchange', () => void render());

  // Keep the header chips fresh when the network flaps.
  window.addEventListener('online', () => void render());
  window.addEventListener('offline', () => {
    toast('Internet went away - work continues, your data is safe.', { tone: 'warn' });
    void render();
  });

  // A single place that explains why an on-device badge might say cloud.
  if (!routerState.demoMode && routerState.capability && routerState.capability.support !== 'available') {
    setTimeout(() => {
      toast(routerState.capability?.reason ?? '', { tone: 'info', ms: 5000 });
    }, 2200);
  }

  void render();
}

/** Small shared header used by every screen. */
export function screenHeader(opts: {
  title: string;
  subtitle?: string;
  right?: Node;
  back?: () => void;
}): HTMLElement {
  const wrap = h('div', { class: 'row gap-8', style: 'margin-bottom:14px;align-items:flex-start' });
  if (opts.back) {
    const b = h('button', { class: 'icon-btn sm', 'aria-label': 'Back' }, '←');
    b.addEventListener('click', opts.back);
    wrap.append(b);
  }
  const text = h(
    'div',
    { style: 'flex:1;min-width:0' },
    h('h1', { style: 'font-size:22px' }, opts.title),
    opts.subtitle ? h('p', { class: 'text-sm muted mt-2' }, opts.subtitle) : null,
  );
  wrap.append(text);
  if (opts.right) wrap.append(opts.right);
  return wrap;
}

export { badge };

