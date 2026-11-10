/**
 * Result — MVP feature 5, the artefact the user actually walks away with.
 *
 * Three exports, each designed for a different real-world use:
 *   • the annotated form image → print it, or show it at the counter
 *   • the answer sheet text    → paste into WhatsApp to a parent, or read it out
 *   • the review summary       → what is left to do, in Hinglish
 *
 * The provenance panel at the bottom is not decoration: it is the hybrid map for
 * THIS form — how many calls ran on-device, how many in the cloud, and how many
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
    screen.append(h('div', { class: 'card empty' }, 'Form nahi mila.'));
    return () => {};
  }
  const loaded = await loadSession(sessionId);
  if (!loaded || !loaded.extraction) {
    screen.append(screenHeader({ title: 'Final form', back: () => go('home') }), h('div', { class: 'card empty' }, 'Pehle form add karein.'));
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
        <div class="row gap-8">${badge({ kind: 'cloud', small: true })}<span class="text-xs muted">review summary</span></div>
        <p class="text-sm muted mt-8">Review summary banaya ja raha hai…</p>
      `;
      void loadSummary();
      return card;
    }
    card.innerHTML = `
      <div class="row wrap gap-6 mb-8">${badge({ kind: 'cloud', small: true, label: 'Cloud summary' })}
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
        summary: 'Summary abhi nahi ban payi — lekin neeche answer sheet poori taiyaar hai.',
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
        <p class="text-xs muted mt-8">Form par jawab chhaap rahe hain…</p>`;
      if (!overlayReady) void makeOverlay();
      return card;
    }
    card.innerHTML = `
      <div class="row between mb-8">
        <b class="text-sm">Bhara hua form</b>
        <button class="text-xs strong" style="background:none;border:0;color:var(--green-700);cursor:pointer" id="zoom">Bada dekhein →</button>
      </div>
      <div class="viewer"><img src="${overlayUrl}" alt="Jawabon ke saath form" /></div>
      <p class="text-2xs muted mt-8">Har field ke rang = traffic light. Neeche patti par likha hai kitne fields cloud-verified hain.</p>
    `;
    card.querySelector('#zoom')?.addEventListener('click', () => {
      if (!overlayUrl) return;
      const body = h('div', { class: 'viewer' });
      body.innerHTML = `<img src="${overlayUrl}" alt="Bhara hua form" />`;
      openSheet({ title: 'Bhara hua form', body });
    });
    return card;
  }

  async function makeOverlay(): Promise<void> {
    if (overlayInFlight) return;
    overlayInFlight = true;
    try {
      const blob = await loadImageBlob(session.id);
      if (!blob) throw new Error('photo nahi mili');
      overlayBlob = await renderOverlay(session, blob);
      overlayUrl = URL.createObjectURL(overlayBlob);
      overlayReady = true;
      paint();
    } catch (err) {
      overlayUrl = null;
      toast(err instanceof Error ? err.message : 'Overlay ban nahi paya', { tone: 'warn' });
      // Show a graceful fallback rather than an infinite spinner.
      const card = screen.querySelector('.card');
      if (card) {
        card.innerHTML = `<div class="note note-warn"><span>⚠️</span><div>Form ki photo is device par nahi mili, isliye overlay nahi ban saka. Answer sheet neeche poori hai.</div></div>`;
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
    const copy = h('button', { class: 'btn btn-secondary btn-sm flex1' }, '📋 Copy karein');
    copy.addEventListener('click', async () => {
      const ok = await copyText(text);
      toast(ok ? 'Copy ho gaya — WhatsApp mein paste kar dein' : 'Copy nahi ho paya', {
        tone: ok ? 'success' : 'error',
      });
    });
    const dl = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ TXT');
    dl.addEventListener('click', () => {
      downloadText(text, sheetFilename(session));
      toast('Download shuru', { tone: 'success' });
    });
    const png = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ PNG');
    png.addEventListener('click', () => {
      if (!overlayBlob) {
        toast('Overlay abhi taiyaar nahi', { tone: 'warn' });
        return;
      }
      downloadBlob(overlayBlob, overlayFilename(session));
      toast('Form ki image download ho rahi hai', { tone: 'success' });
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
        <b class="text-sm">Is form ka hybrid hisaab</b>
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
      <p class="text-2xs muted mt-8">${split.redactedCalls} calls mein personal values redact hue. Interview aur extraction ke values aapke phone se bahar nahi gaye.</p>
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
          h('b', {}, 'Aage kya? '),
          'Form print karein, sign karein, aur zaroori documents ke saath office mein jama karein. FormSathi khud submit nahi karta — yeh aapka saathi hai, aapki jagah nahi.',
        ),
      ),
      h(
        'div',
        { class: 'row gap-8 mt-12' },
        (() => {
          const b = h('button', { class: 'btn btn-primary flex1' }, 'Naya form shuru karein');
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
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export { light };
