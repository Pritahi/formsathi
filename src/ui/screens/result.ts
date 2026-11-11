/**
 * Result - MVP feature 5, the artefact the user actually walks away with.
 *
 * Three exports, each designed for a different real-world use:
 *   • the annotated form image → print it, or show it at the counter
 *   • the answer sheet text    → paste into WhatsApp to a parent, or read it out
 *   • the review summary       → what is left to do
 *
 * The provenance panel at the bottom is not decoration: it is the hybrid map for
 * THIS form - how many calls ran on-device, how many in the cloud, and how many
 * bytes of image actually left the phone.
 */

import { h, toast, openSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badge, lightCounts, light } from '../badges';
import { state } from '../../store/app';
import {
  loadSession,
  loadImageBlob,
  lightCounts as countsFor,
  saveSession,
} from '../../services/sessions';
import {
  buildAnswerSheet,
  renderOverlay,
  copyText,
  downloadBlob,
  downloadText,
  sheetFilename,
  overlayFilename,
} from '../../services/export';
import { routeReviewSummary } from '../../ai/router';
import type { FormSession } from '../../lib/types';
import { sessionSplit } from '../../ai/logCursor';
import { openRouterLog } from '../routerLog';

export async function renderResult(host: HTMLElement, sessionId?: string): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  if (!sessionId) {
    screen.append(h('div', { class: 'card empty' }, 'Form not found.'));
    return () => {};
  }
  const loaded = await loadSession(sessionId);
  if (!loaded || !loaded.extraction) {
    screen.append(screenHeader({ title: 'Final form', back: () => go('home') }), h('div', { class: 'card empty' }, 'Add a form first.'));
    return () => {};
  }
  const session: FormSession = loaded;

  let overlayUrl: string | null = null;
  let overlayBlob: Blob | null = null;
  let summary: { summary: string; nextSteps: string[]; confidence: number } | null = null;
  // paint() re-runs before the (async) summary lands, which would otherwise fire
  // a second cloud call and log the same review twice in the Model Router log.
  let overlayInFlight = false;
  let overlayReady = false;
  let summaryInFlight = false;
  let summaryFinished = false;

  const paint = (): void => {
    const counts = countsFor(session);
    screen.replaceChildren(
      screenHeader({
        title: 'Final form',
        subtitle: session.title,
        back: () => go('checklist', session.id),
        right: (() => {
          const d = h('div');
          d.innerHTML = lightCounts(counts);
          return d;
        })(),
      }),
      summaryCard(),
      overlayCard(),
      sheetCard(),
      provenanceCard(),
      footerNote(),
    );
  };

  /* ── review summary ─────────────────────────────────────────────────── */

  function summaryCard(): HTMLElement {
    const card = h('div', { class: 'card mb-12' });
    if (!summary) {
      card.innerHTML = `
        <div class="row gap-8">${badge({ kind: state.settings.demoMode ? 'demo' : 'offline', small: true, label: state.settings.demoMode ? 'Mock review' : 'Local template (no AI)' })}<span class="text-xs muted">review summary</span></div>
        <p class="text-sm muted mt-8">Building the review summary…</p>
      `;
      void loadSummary();
      return card;
    }
    card.innerHTML = `
      <div class="row wrap gap-6 mb-8">${badge({ kind: state.settings.demoMode ? 'demo' : 'offline', small: true, label: state.settings.demoMode ? 'Mock summary' : 'Local summary (no AI)' })}
      ${state.settings.demoMode ? badge({ kind: 'demo', small: true }) : ''}
      <span class="text-xs muted">${Math.round(summary.confidence * 100)}%</span></div>
      <p class="text-sm" style="line-height:1.55">${escape(summary.summary)}</p>
      ${
        summary.nextSteps.length
          ? `<ul class="text-xs muted mt-12" style="padding-left:16px;line-height:1.65">${summary.nextSteps
              .map((s) => `<li>${escape(s)}</li>`)
              .join('')}</ul>`
          : ''
      }
    `;
    return card;
  }

  async function loadSummary(): Promise<void> {
    if (summaryInFlight || summaryFinished) return;
    summaryInFlight = true;
    const counts = countsFor(session);
    const issues = (session.verify?.verdicts ?? [])
      .filter((v) => v.status !== 'ok')
      .map((v) => ({
        label: session.extraction!.fields.find((f) => f.id === v.fieldId)?.label ?? v.fieldId,
        reason: v.reason ?? '',
      }));
    try {
      const out = await routeReviewSummary({
        formTitle: session.title,
        counts,
        issues,
        instructionAvailable: !!session.instructionText?.trim(),
      });
      summary = { summary: out.summary, nextSteps: out.nextSteps, confidence: out.confidence };
      summaryFinished = true;
      paint();
    } catch {
      summary = {
        summary: 'The summary could not be built right now - but the answer sheet below is ready.',
        nextSteps: [],
        confidence: 0.5,
      };
      summaryFinished = true;
      paint();
    } finally {
      summaryInFlight = false;
    }
  }

  /* ── overlay ────────────────────────────────────────────────────────── */

  function overlayCard(): HTMLElement {
    const card = h('div', { class: 'card mb-12' });
    if (!overlayUrl) {
      card.innerHTML = `<div class="progress progress-indeterminate"><i style="width:40%"></i></div>
        <p class="text-xs muted mt-8">Printing answers on the form…</p>`;
      if (!overlayReady) void makeOverlay();
      return card;
    }
    card.innerHTML = `
      <div class="row between mb-8">
        <b class="text-sm">Filled form</b>
        <button class="text-xs strong" style="background:none;border:0;color:var(--green-700);cursor:pointer" id="zoom">View larger →</button>
      </div>
      <div class="viewer"><img src="${overlayUrl}" alt="Form with answers" /></div>
      <p class="text-2xs muted mt-8">Each field's colour = traffic light. The strip below shows how many fields are cloud-verified.</p>
    `;
    card.querySelector('#zoom')?.addEventListener('click', () => {
      if (!overlayUrl) return;
      const body = h('div', { class: 'viewer' });
      body.innerHTML = `<img src="${overlayUrl}" alt="Filled form" />`;
      openSheet({ title: 'Filled form', body });
    });
    return card;
  }

  async function makeOverlay(): Promise<void> {
    if (overlayInFlight) return;
    overlayInFlight = true;
    try {
      const blob = await loadImageBlob(session.id);
      if (!blob) throw new Error('photo not found');
      overlayBlob = await renderOverlay(session, blob);
      overlayUrl = URL.createObjectURL(overlayBlob);
      overlayReady = true;
      paint();
    } catch (err) {
      overlayUrl = null;
      toast(err instanceof Error ? err.message : 'Overlay could not be created', { tone: 'warn' });
      // Show a graceful fallback rather than an infinite spinner.
      const card = screen.querySelector('.card');
      if (card) {
        card.innerHTML = `<div class="note note-warn"><span>⚠️</span><div>The form photo is not on this device, so the overlay could not be created. The answer sheet below is complete.</div></div>`;
      }
    }
  }

  /* ── answer sheet ───────────────────────────────────────────────────── */

  function sheetCard(): HTMLElement {
    const text = buildAnswerSheet(session);
    const card = h('div', { class: 'card mb-12' });
    card.innerHTML = `
      <div class="row between mb-8">
        <b class="text-sm">Answer sheet</b>
        <span class="badge badge-device badge-sm"><span class="badge-ic">📱</span><span class="badge-tx">on-device</span></span>
      </div>
      <pre class="code" style="max-height:38vh" id="sheet">${escape(text)}</pre>
    `;
    const row = h('div', { class: 'row wrap gap-8 mt-12' });
    const copy = h('button', { class: 'btn btn-secondary btn-sm flex1' }, '📋 Copy');
    copy.addEventListener('click', async () => {
      const ok = await copyText(text);
      toast(ok ? 'Copied - paste into WhatsApp' : 'Copy failed', {
        tone: ok ? 'success' : 'error',
      });
    });
    const dl = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ TXT');
    dl.addEventListener('click', () => {
      downloadText(text, sheetFilename(session));
      toast('Download started', { tone: 'success' });
    });
    const png = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ PNG');
    png.addEventListener('click', () => {
      if (!overlayBlob) {
        toast('Overlay not ready yet', { tone: 'warn' });
        return;
      }
      downloadBlob(overlayBlob, overlayFilename(session));
      toast('Form image downloading', { tone: 'success' });
    });
    row.append(copy, dl, png);
    card.append(row);
    return card;
  }

  /* ── provenance: this form's hybrid map ─────────────────────────────── */

  function provenanceCard(): HTMLElement {
    const split = sessionSplit(session.id);
    const card = h('div', { class: 'card-flat mb-12' });
    const kb = (split.bytesUp / 1024).toFixed(0);
    card.innerHTML = `
      <div class="row between">
        <b class="text-sm">This form's hybrid account</b>
        <button class="text-xs strong" style="background:none;border:0;color:var(--green-700);cursor:pointer" id="log">Log →</button>
      </div>
      <div class="row gap-8 mt-8">
        <div class="stat" style="border-color:#bfe0cc;background:var(--green-100)">
          <div class="n" style="color:var(--green-800)">${split.onDevice}</div><div class="l">on-device calls</div></div>
        <div class="stat" style="border-color:#c7ddf5;background:var(--blue-100)">
          <div class="n" style="color:#14528f">${split.cloud}</div><div class="l">cloud calls</div></div>
        <div class="stat">
          <div class="n">${kb} KB</div><div class="l">image uploaded</div></div>
      </div>
      <p class="text-2xs muted mt-8">${split.redactedCalls} calls had personal values redacted. Interview and extraction values never left your phone.</p>
    `;
    card.querySelector('#log')?.addEventListener('click', () => openRouterLog());
    return card;
  }

  function footerNote(): HTMLElement {
    return h(
      'div',
      { class: 'mt-8' },
      h(
        'div',
        { class: 'note' },
        h('span', {}, '🤝'),
        h(
          'div',
          {},
          h('b', {}, 'What next? '),
          'Print the form, sign it, and submit it at the office with the required documents. FormSathi does not submit on your behalf - it is your helper, not your stand-in.',
        ),
      ),
      h(
        'div',
        { class: 'row gap-8 mt-12' },
        (() => {
          const b = h('button', { class: 'btn btn-primary flex1' }, 'Start a new form');
          b.addEventListener('click', () => go('intake', 'photo'));
          return b;
        })(),
        (() => {
          const b = h('button', { class: 'btn btn-secondary btn-sm' }, '🔐 Vault');
          b.addEventListener('click', () => go('vault'));
          return b;
        })(),
      ),
    );
  }

  paint();
  await saveSession(session, true);

  return () => {
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
  };

}

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
}

export { light };
