/**
 * The router log drawer - the app's evidence panel.
 *
 * This is not a debug console hidden behind a flag; it is a first-class screen,
 * because the hybrid claim has to be inspectable by a judge in five seconds.
 * It shows, per call: what the router WANTED, what actually ran, the model, the
 * latency, how many bytes went up, and whether values were redacted.
 *
 * The same data source feeds the README's hybrid inference map, so the table in
 * the docs and the table on screen cannot drift apart.
 */

import { escapeHtml as esc } from '../lib/util';
import { html, raw, openSheet, toast } from './dom';
import { badgeForLog } from './badges';
import { ROUTE_TABLE, routerState, onRouterLog, hybridSnapshot } from '../ai/router';
import type { RouteTask } from '../lib/types';
import type { RouteLogEntry } from '../lib/types';

const TASK_LABELS: Record<RouteTask, string> = {
  field_extraction: 'Read form',
  interview_turn: 'Ask question',
  answer_repair: 'Clean up answer',
  cloud_verify: 'Cloud verify',
  review_summary: 'Review summary',
  freeform_chat: 'Free chat',
};

const TASK_ICON: Record<RouteTask, string> = {
  field_extraction: '📷',
  interview_turn: '💬',
  answer_repair: '✏️',
  cloud_verify: '☁️',
  review_summary: '📝',
  freeform_chat: '❓',
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtBytes(b?: number): string {
  if (!b) return '-';
  return b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The hybrid inference map, rendered from ROUTE_TABLE (single source of truth). */
export function hybridMapTable(opts: { compact?: boolean } = {}): HTMLElement {
  const tasks = Object.keys(ROUTE_TABLE) as RouteTask[];
  const rows = tasks
    .map((task) => {
      const d = ROUTE_TABLE[task];
      return html`<tr>
        <td>
          <div class="strong">${TASK_ICON[task]} ${TASK_LABELS[task]}</div>
          <div class="text-2xs muted mono">${task}</div>
        </td>
        <td>${raw(badgeForPath(d.path))}</td>
        <td class="text-xs">${d.reason}</td>
        <td class="text-2xs muted">${d.offlineCapable ? 'yes' : 'no'} / ${d.privateByDesign ? 'yes' : 'no'}</td>
      </tr>`;
    })
    .join('');

  const wrap = document.createElement('div');
  wrap.className = 'col gap-8';
  wrap.innerHTML = `
    <div class="map-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Step</th><th>Where it runs</th><th>Why</th><th>Offline / Private</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${
      opts.compact
        ? ''
        : `<p class="text-2xs muted">This table renders straight from <code>src/ai/router.ts → ROUTE_TABLE</code>. The README table is the same.</p>`
    }
  `;
  return wrap;
}

function badgeForPath(path: 'on-device' | 'cloud'): string {
  return path === 'on-device'
    ? `<span class="badge badge-device"><span class="badge-ic">📱</span><span class="badge-tx">On-device</span></span>`
    : `<span class="badge badge-cloud"><span class="badge-ic">☁️</span><span class="badge-tx">Cloud</span></span>`;
}

/** One log row. */
function logRow(entry: RouteLogEntry): string {
  const offlineMark = entry.offline
    ? `<span class="badge badge-offline badge-sm"><span class="badge-ic">✈️</span><span class="badge-tx">offline</span></span>`
    : '';
  const requested =
    entry.requestedPath !== 'cloud' && entry.actualPath.includes('cloud') && entry.ok
      ? `<span class="text-2xs muted">(wanted on-device)</span>`
      : '';
  return html`<div class="card card-tight">
    <div class="row between gap-8">
      <div class="row gap-6" style="min-width:0">
        <span aria-hidden="true">${TASK_ICON[entry.task]}</span>
        <b class="text-sm">${TASK_LABELS[entry.task]}</b>
        ${raw(requested)}
      </div>
      <span class="text-2xs muted mono">${timeOf(entry.at)}</span>
    </div>
    <div class="row wrap gap-6 mt-8">
      ${raw(badgeForLog(entry))}
      ${raw(offlineMark)}
      ${entry.redacted ? raw(`<span class="badge badge-offline badge-sm"><span class="badge-ic">🔒</span><span class="badge-tx">redacted</span></span>`) : ''}
      ${entry.ok ? '' : raw(`<span class="badge badge-fallback badge-sm"><span class="badge-ic">!</span><span class="badge-tx">fail</span></span>`)}
    </div>
    <dl class="kv mt-8">
      <dt>Model</dt><dd class="mono text-2xs">${entry.model}</dd>
      <dt>Latency</dt><dd>${fmtMs(entry.latencyMs)}</dd>
      <dt>Image up</dt><dd>${fmtBytes(entry.imageBytes)}</dd>
      <dt>Prompt</dt><dd>${entry.promptChars} chars${entry.task === 'interview_turn' ? ' (single-turn, packed)' : ''}</dd>
    </dl>
    <p class="text-2xs muted mt-8">${entry.reason}</p>
    ${entry.error ? html`<p class="field-error text-2xs mt-2">${entry.error}</p>` : ''}
  </div>`.toString();
}

/** The full drawer. */
export function openRouterLog(): void {
  const body = document.createElement('div');
  body.className = 'col gap-12';

  const snap = hybridSnapshot();
  const summary = document.createElement('div');
  summary.className = 'row wrap gap-6';
  summary.innerHTML = `
    <div class="stat"><div class="n">${snap.onDeviceCalls}</div><div class="l">on-device</div></div>
    <div class="stat"><div class="n">${snap.cloudCalls}</div><div class="l">cloud</div></div>
    <div class="stat"><div class="n">${snap.fallbacks}</div><div class="l">fallback</div></div>
    <div class="stat"><div class="n">${routerState.logs.filter((l) => l.redacted).length}</div><div class="l">redacted</div></div>
  `;

  const live = document.createElement('div');
  live.className = 'col gap-8';

  const renderLive = () => {
    const logs = routerState.logs;
    live.innerHTML = logs.length
      ? logs.slice(0, 40).map(logRow).join('')
      : `<div class="empty"><span class="ic">📋</span>No AI calls yet.<br /><span class="text-xs">When you read a form, every call will show here - which ran on-device, which in the cloud.</span></div>`;
  };
  renderLive();

  const tabs = document.createElement('div');
  tabs.className = 'pill-tabs';
  tabs.innerHTML = `
    <button class="pill-tab" aria-selected="true" data-tab="calls">Calls (${routerState.logs.length})</button>
    <button class="pill-tab" aria-selected="false" data-tab="map">Hybrid map</button>
    <button class="pill-tab" aria-selected="false" data-tab="device">Device</button>
  `;

  const mapPane = hybridMapTable();
  mapPane.classList.add('hidden');

  const devicePane = document.createElement('div');
  devicePane.className = 'col gap-10 hidden';
  const cap = routerState.capability;
  devicePane.innerHTML = `
    <div class="note">
      <span aria-hidden="true">💡</span>
      <div>
        <b>When does on-device run?</b><br />
        Gemini Nano via Chrome's Prompt API - <b>only desktop Chrome 139+</b>, once the model is downloaded.
        On phones, Safari and Firefox the app runs the cloud path, and the badge tells the truth.
      </div>
    </div>
    <dl class="kv">
      <dt>Demo mode</dt><dd>${snap.demoMode ? 'ON (mock models)' : 'OFF (live Firebase AI Logic)'}</dd>
      <dt>Network</dt><dd>${snap.offline ? 'offline' : 'online'}</dd>
      <dt>Device support</dt><dd>${esc(cap?.support ?? 'not probed yet')}</dd>
      <dt>Browser</dt><dd>${esc(cap?.detail.browser ?? '-')} ${cap?.detail.chromiumMajor ? `(v${cap.detail.chromiumMajor})` : ''}</dd>
      <dt>Desktop</dt><dd>${cap?.detail.isDesktop ? 'yes' : 'no'}</dd>
      <dt>Prompt API</dt><dd>${cap?.detail.hasPromptApi ? 'present' : 'absent'}</dd>
      <dt>HTTPS</dt><dd>${cap?.detail.secureContext ? 'yes' : 'no'}</dd>
    </dl>
    <p class="text-xs muted">${esc(cap?.reason ?? '')}</p>
    <p class="text-2xs muted-2">On-device tasks: ${snap.onDeviceTasks.join(', ')}<br />Cloud tasks: ${snap.cloudTasks.join(', ')}</p>
  `;

  body.append(summary, tabs, live, mapPane, devicePane);

  tabs.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.pill-tab');
    if (!btn) return;
    for (const b of tabs.querySelectorAll('.pill-tab')) b.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-selected', 'true');
    const tab = btn.dataset.tab;
    live.classList.toggle('hidden', tab !== 'calls');
    mapPane.classList.toggle('hidden', tab !== 'map');
    devicePane.classList.toggle('hidden', tab !== 'device');
  });

  const footer = document.createElement('div');
  footer.className = 'row gap-8';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-secondary btn-sm flex1';
  copyBtn.textContent = '📋 Copy log';
  copyBtn.addEventListener('click', async () => {
    const text = routerState.logs
      .map(
        (l) =>
          `${new Date(l.at).toISOString()} | ${l.task} | requested=${l.requestedPath} | actual=${l.actualPath} | ${l.model} | ${l.latencyMs}ms | img=${l.imageBytes ?? 0}B | redacted=${l.redacted} | ${l.reason}`,
      )
      .join('\\n');
    try {
      await navigator.clipboard.writeText(text || 'no calls yet');
      toast('Log copied to clipboard', { tone: 'success' });
    } catch {
      toast('Copy failed', { tone: 'error' });
    }
  });
  footer.append(copyBtn);

  const sheet = openSheet({
    title: 'Model Router log',
    subtitle: 'Which call ran where - an account of every call',
    body,
    footer,
  });

  // Live updates while the drawer is open (the demo records this screen).
  const off = onRouterLog(() => {
    if (!document.body.contains(sheet.root)) {
      off();
      return;
    }
    renderLive();
  });
}

