/**
 * Minimal DOM layer. No framework, no virtual DOM, no build step magic.
 *
 * Rationale: the app must boot in under a second on a mid-range Android over a
 * patchy connection. A React runtime would cost more than every screen of UI in
 * this project combined. The one thing a framework gives us that actually
 * matters here - safe interpolation of user/model text - is covered by `esc()`
 * and the rule that all dynamic text goes through `tpl` tagged templates or
 * `textNode()`.
 */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** HTML-escape. Every dynamic string in this app passes through here. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tagged template that escapes interpolations by default. Use `raw()` for
 * pre-built HTML fragments (which must themselves be escaped at the source).
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined || v === false) return;
      if (Array.isArray(v)) {
        out += v.map((x) => (isRaw(x) ? (x as Raw).value : esc(x))).join('');
      } else if (isRaw(v)) {
        out += (v as Raw).value;
      } else {
        out += esc(v);
      }
    }
  });
  return out;
}

interface Raw {
  __raw: true;
  value: string;
}
const isRaw = (v: unknown): v is Raw =>
  typeof v === 'object' && v !== null && (v as Raw).__raw === true;

/** Mark a string as already-safe HTML. */
export function raw(value: string): Raw {
  return { __raw: true, value };
}

/** Build an element from an HTML string. */
export function el(htmlString: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = htmlString.trim();
  const node = t.content.firstElementChild;
  if (!(node instanceof HTMLElement)) throw new Error('el(): template produced no element');
  return node;
}

/** h('div', {class:'x', onclick: fn}, children…) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'text') {
      node.textContent = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else if (k === 'style' && typeof v === 'string') {
      node.setAttribute('style', v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

/** Replace a container's content. */
export function mount(container: HTMLElement, ...children: Child[]): void {
  container.replaceChildren();
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    container.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Delegated click handler: [data-action] anywhere inside root. */
export function onAction(root: HTMLElement, handler: (action: string, target: HTMLElement, ev: Event) => void): () => void {
  const listener = (ev: Event) => {
    const t = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!t || !root.contains(t)) return;
    handler(t.dataset.action ?? '', t, ev);
  };
  root.addEventListener('click', listener);
  return () => root.removeEventListener('click', listener);
}

/* ── Toasts & sheets ──────────────────────────────────────────────────── */

let toastHost: HTMLElement | null = null;

export function toast(message: string, opts: { tone?: 'info' | 'warn' | 'error' | 'success'; ms?: number } = {}): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast toast-${opts.tone ?? 'info'}` }, message);
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 250);
  }, opts.ms ?? 3200);
}

export interface SheetHandle {
  close(): void;
  root: HTMLElement;
}

/** Every open sheet, so a route change can dismiss them. Without this a sheet
 * left open on one screen keeps its scrim over the next screen and swallows
 * every tap - the kind of bug that only shows up on a phone. */
const openSheets = new Set<{ close: () => void }>();

export function closeAllSheets(): void {
  for (const s of Array.from(openSheets)) s.close();
  openSheets.clear();
}

/** Bottom sheet - the app's only modal pattern (mobile-first, no dialogs that
 * break on iOS Safari). */
export function openSheet(opts: {
  title: string;
  subtitle?: string;
  body: Node | string;
  footer?: Node | string;
  onClose?: () => void;
}): SheetHandle {
  const scrim = h('div', { class: 'sheet-scrim' });
  const panel = h(
    'div',
    { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h(
      'div',
      { class: 'sheet-head' },
      h(
        'div',
        {},
        h('h2', { class: 'sheet-title' }, opts.title),
        opts.subtitle ? h('p', { class: 'sheet-sub' }, opts.subtitle) : null,
      ),
      h('button', { class: 'icon-btn', 'data-action': 'sheet-close', 'aria-label': 'Close' }, '✕'),
    ),
    h('div', { class: 'sheet-body' }, opts.body as Node),
    opts.footer ? h('div', { class: 'sheet-foot' }, opts.footer as Node) : null,
  );

  const self = {
    close: () => {
      if (!scrim.isConnected && !panel.isConnected) return;
      scrim.classList.remove('in');
      panel.classList.remove('in');
      setTimeout(() => {
        scrim.remove();
        panel.remove();
        opts.onClose?.();
      }, 200);
    }
  };
  openSheets.add(self);
  const close = () => {
    openSheets.delete(self);
    self.close();
  };

  scrim.addEventListener('click', close);
  panel.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('[data-action="sheet-close"]');
    if (t) close();
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  document.body.append(scrim, panel);
  requestAnimationFrame(() => {
    scrim.classList.add('in');
    panel.classList.add('in');
  });

  return { close, root: panel };
}

/** Confirm helper built on the sheet (window.confirm is blocked in some
 * installed-PWA contexts). */
export function confirmSheet(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const handle = openSheet({
      title: opts.title,
      body: h('p', { class: 'sheet-text' }, opts.message),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn btn-ghost flex1', 'data-action': 'cancel' }, 'Cancel'),
        h(
          'button',
          { class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'} flex1`, 'data-action': 'ok' },
          opts.confirmLabel,
        ),
      ),
    });
    handle.root.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-action]');
      if (!t) return;
      const a = (t as HTMLElement).dataset.action;
      if (a === 'ok') {
        resolve(true);
        handle.close();
      } else if (a === 'cancel') {
        resolve(false);
        handle.close();
      }
    });
  });
}

/** Format a relative time in English. */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hh = Math.round(m / 60);
  if (hh < 24) return `${hh} hours ago`;
  const d = Math.round(hh / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString('en-IN');
}

