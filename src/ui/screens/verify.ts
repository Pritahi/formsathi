/**
 * Cloud verify screen - MVP feature 4 and the demo's second act.
 *
 * The flow the screen has to make obvious, in this order:
 *   1. the instruction page is what makes verification real (not generic advice)
 *   2. the payload is redacted - there is a button that shows exactly what
 *      will be sent, before anything is sent
 *   3. the result is per-field, in English, with a one-tap fix
 *   4. if offline, it queues and says so honestly
 */

import { h, toast, openSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badge, provenanceLine, lightCounts } from '../badges';
import { state, subscribe } from '../../store/app';
import { loadSession, saveSession, lightCounts as countsFor } from '../../services/sessions';
import { runCloudVerify, receiptFor } from '../../services/verify';
import { buildCloudPayload } from '../../ai/redact';
import { buildCloudVerifyPrompt } from '../../ai/prompts';
import { processFile } from '../../lib/image';
import { SAMPLE_INSTRUCTIONS_IMAGE } from '../../data/sampleLayouts';
import type { FormSession } from '../../lib/types';
import { InterviewEngine } from '../../services/interview';
import { openRouterLog } from '../routerLog';
import { getLastRouteLog } from '../../ai/logCursor';

export async function renderVerify(host: HTMLElement, sessionId?: string): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  if (!sessionId) {
    screen.append(h('div', { class: 'card empty' }, 'Form not found.'));
    return () => {};
  }
  const loaded = await loadSession(sessionId);
  if (!loaded || !loaded.extraction) {
    screen.append(
      screenHeader({ title: 'Cloud verify', back: () => go('home') }),
      h('div', { class: 'card empty' }, 'Add a form first.'),
    );
    return () => {};
  }
  // `let`: the offline queue mutates a FRESHLY loaded copy of this session, so
  // the screen must be able to swap in the new object when the replay finishes.
  let session: FormSession = loaded;

  const engine = new InterviewEngine(session, {
    onTurn: () => {},
    onAnswer: () => {},
    onDone: () => {},
    onError: (m) => toast(m, { tone: 'error' }),
  });

  let running = false;

  const paint = (): void => {
    screen.replaceChildren(
      screenHeader({
        title: 'Cloud verify',
        subtitle: 'Match against the official instruction page',
        back: () => go('checklist', session.id),
      }),
      statusCard(),
      instructionCard(),
      privacyCard(),
      running ? workingCard() : session.verify ? resultsCard() : startCard(),
      footer(),
    );
  };

  /* ── cards ──────────────────────────────────────────────────────────── */

  function statusCard(): HTMLElement {
    const counts = countsFor(session);
    const wrap = h('div', { class: 'row gap-8 mb-12' });
    wrap.innerHTML = `${lightCounts(counts)}<span class="text-xs muted">${
      session.verifyStatus === 'queued' ? '· verify queued' : session.verify ? '· verified' : ''
    }</span>`;
    return wrap;
  }

  function instructionCard(): HTMLElement {
    const card = h('div', { class: 'card mb-12' });
    const has = !!session.instructionText?.trim();
    card.innerHTML = `
      <div class="row between">
        <div class="row gap-8" style="min-width:0">
          <span class="avatar" aria-hidden="true">📋</span>
          <div style="min-width:0">
            <div class="card-title">Form\'s official instructions</div>
            <div class="text-xs muted">${has ? session.instructionText!.trim().split(/\\s+/).length + ' words read' : 'Not added yet'}</div>
          </div>
        </div>
        ${has ? badge({ kind: 'on-device', small: true, label: 'Ready' }) : ''}
      </div>
      <p class="text-xs muted mt-8">${
        has
          ? 'Verify will happen against these lines - not generic advice. That is how a mistake like "write monthly income" gets caught.'
          : 'Take a photo of the instruction page (or use the sample). Without it, cloud can only check format, not the scheme\'s rules.'
      }</p>
    `;

    const row = h('div', { class: 'row gap-8 mt-12' });
    const sampleBtn = h('button', { class: 'btn btn-secondary btn-sm flex1' }, '🎬 Sample instructions');
    sampleBtn.addEventListener('click', () => void useSampleInstructions());
    const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' }) as HTMLInputElement;
    camInput.addEventListener('change', () => {
      const f = camInput.files?.[0];
      if (f) void usePhotoInstructions(f);
    });
    const camBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '📷 Photo');
    camBtn.addEventListener('click', () => camInput.click());
    row.append(sampleBtn, camBtn);
    card.append(row, camInput);
    return card;
  }

  function privacyCard(): HTMLElement {
    const { payload, report } = buildCloudPayload(session.extraction!.fields, session.answers);
    const card = h('div', { class: 'card-flat mb-12' });
    card.innerHTML = `
      <div class="row between">
        <div class="row gap-8">
          <span aria-hidden="true">🔒</span>
          <b class="text-sm">What goes to the cloud</b>
        </div>
        <button class="text-xs strong" style="background:none;border:0;color:var(--green-700);cursor:pointer" id="peek">View →</button>
      </div>
      <p class="text-xs muted mt-8">${
        report.redactedFieldIds.length > 0
          ? `<b>${report.redactedFieldIds.length} personal field(s)</b> hidden before sending (Aadhaar, mobile, address and similar). The cloud sees only their format.`
          : 'No sensitive field found in this form - only labels, formats and the instruction page will be sent.'
      }</p>
    `;
    card.querySelector('#peek')?.addEventListener('click', () => {
      const body = h('div', { class: 'col gap-8' });
      const receipt = receiptFor(session.id);
      body.innerHTML = `
        <p class="text-sm muted">This is <b>exactly</b> the payload that will go to the cloud model. ${receipt ? '' : 'The full receipt will also appear here after verify runs.'}</p>
        <pre class="code">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
        ${receipt ? `<div class="label mt-8">Receipt</div><pre class="code">${escapeHtml(receipt)}</pre>` : ''}
        <div class="note note-ok"><span>✓</span><div>Your identity values - Aadhaar, mobile, bank account, address, pincode - are <b>nowhere</b> in this payload. In their place are device-computed <b>format facts</b> (such as <code>digits=12, has-plus-prefix</code>), so cloud can catch mistakes without ever seeing the number itself.</div></div>
      `;
      openSheet({ title: 'Cloud payload', subtitle: 'Redaction proof', body });
    });
    return card;
  }

  function startCard(): HTMLElement {
    const card = h('div', { class: 'col gap-10' });
    const has = !!session.instructionText?.trim() || state.settings.demoMode;

    const info = h('div', { class: `note ${has ? '' : 'note-warn'}` });
    info.innerHTML = `<span>${has ? '☁️' : '⚠️'}</span><div>${
      has
        ? 'The cloud model will match your filled form against the official instructions, explain mistakes in English, and suggest fixes.'
        : 'You have not added an instruction page. Verify will only check format (is income in figures, is the mobile 10 digits) - not the scheme\'s rules.'
    }</div>`;

    const btn = h('button', { class: 'btn btn-primary btn-lg btn-block' }, '☁️ Start verify');
    btn.addEventListener('click', () => void doVerify());

    const demoRow = h('div', { class: 'row gap-8 mt-8' });
    demoRow.innerHTML = `<span class="text-xs muted">Demo mistake:</span>`;
    const profiles: Array<{ k: 'income-monthly' | 'plus91' | 'wrong-ifsc' | 'clean'; label: string }> = [
      { k: 'income-monthly', label: 'monthly income' },
      { k: 'plus91', label: '+91 mobile' },
      { k: 'wrong-ifsc', label: 'wrong IFSC' },
      { k: 'clean', label: 'all fine' },
    ];
    for (const p of profiles) {
      const chip = h(
        'button',
        { class: 'chip', style: 'font-size:12.5px;min-height:32px;padding:5px 11px', 'aria-pressed': String(state.settings.demoVerifyProfile === p.k) },
        p.label,
      );
      chip.addEventListener('click', async () => {
        const { saveSettings } = await import('../../store/app');
        await saveSettings({ demoVerifyProfile: p.k });
        paint();
      });
      demoRow.append(chip);
    }

    card.append(info, btn);
    if (state.settings.demoMode) {
      card.append(
        h(
          'p',
          { class: 'text-2xs muted mt-2' },
          'In DEMO MODE verify comes from a mock cloud - but it runs the same rule engine given to the live model. Choose "monthly income": if you wrote 5000 as income, verify will catch it.',
        ),
      );
      card.append(demoRow);
    }
    return card;
  }

  function workingCard(): HTMLElement {
    const card = h('div', { class: 'card' });
    card.innerHTML = `
      <div class="row gap-8">${badge({ kind: 'cloud' })}${state.settings.demoMode ? badge({ kind: 'demo' }) : ''}</div>
      <p class="text-sm mt-8">The cloud model is reading the instructions and matching them against your answers…</p>
      <div class="progress progress-indeterminate mt-12"><i style="width:40%"></i></div>
      <p class="text-2xs muted mt-8">This step needs internet. Personal values are redacted - the cloud does not see them.</p>
    `;
    return card;
  }

  /**
   * Some verdicts carry a machine-ish rule string ("Instruction 10: incomplete
   * applications rejected") that only restates the reason above and reads like
   * an internal error code to a first-time user. Show the rule only when it
   * actually names a checkable constraint the person can act on.
   */
  function displayRule(rule?: string): string | null {
    if (!rule) return null;
    const r = rule.trim();
    if (!r) return null;
    if (/^instruction\\s*\\d+/i.test(r)) return null;
    if (/incomplete applications? rejected/i.test(r)) return null;
    return r;
  }

  function resultsCard(): HTMLElement {
    const v = session.verify!;
    const card = h('div', { class: 'col gap-10' });
    const log = getLastRouteLog(session.id, 'cloud_verify');

    const head = h('div', { class: 'card' });
    head.innerHTML = `
      <div class="row wrap gap-6 mb-8">${badge({ kind: 'cloud' })}${state.settings.demoMode ? badge({ kind: 'demo' }) : ''}
        <span class="text-xs muted">${Math.round(v.overallConfidence * 100)}% confidence</span></div>
      <p class="text-sm" style="line-height:1.5">${escape(v.summary)}</p>
      ${log ? provenanceLine(log) : ''}
    `;
    card.append(head);

    const issues = v.verdicts.filter((x) => x.status !== 'ok');
    if (issues.length > 0) {
      const list = h('div', { class: 'col gap-8' });
      for (const issue of issues) {
        const field = session.extraction!.fields.find((f) => f.id === issue.fieldId);
        const row = h('div', { class: `card card-tight field-${issue.status === 'fix' ? 'red' : 'yellow'}` });
        row.innerHTML = `
          <div class="row between gap-8">
            <b class="text-sm">${escape(field?.label ?? issue.fieldId)}</b>
            <span class="badge ${issue.status === 'fix' ? 'badge-fallback' : 'badge-queued'} badge-sm\">
              <span class="badge-ic">${issue.status === 'fix' ? '✗' : '!'}</span>
              <span class="badge-tx">${issue.status === 'fix' ? 'Fix' : 'Review'}</span>
            </span>
          </div>
          <p class="text-xs mt-8" style="line-height:1.5">${escape(issue.reason ?? '')}</p>
          ${
            displayRule(issue.rule)
              ? `<p class="text-2xs muted mt-2">Rule: ${escape(displayRule(issue.rule)!)}</p>`
              : ''
          }
          ${
            issue.suggestedValue
              ? `<div class="row gap-8 mt-8">
                   <button class="btn btn-saffron btn-sm flex1" data-accept="${escape(issue.suggestedValue)}">✨ Apply ${escape(issue.suggestedValue)}</button>
                 </div>`
              : ''
          }
        `;
        row.querySelector('[data-accept]')?.addEventListener('click', async (ev) => {
          const val = (ev.currentTarget as HTMLElement).dataset.accept ?? '';
          await engine.acceptSuggestion(issue.fieldId, val);
          session.verify!.verdicts = session.verify!.verdicts.filter((x) => x.fieldId !== issue.fieldId);
          await saveSession(session, true);
          paint();
          toast('Correction applied ✓ Light is green now.', { tone: 'success' });
        });
        list.append(row);
      }
      card.append(list);
    } else {
      const ok = h('div', { class: 'note note-ok' });
      ok.innerHTML = '<span>✓</span><div>Cloud verify found no mistakes. Everything matches the instructions.</div>';
      card.append(ok);
    }

    if (v.instructionsUsed?.length) {
      const used = h('div', { class: 'card-flat' });
      used.innerHTML = `
        <b class="text-sm">Which instructions were used</b>
        <ul class="text-xs muted mt-8" style="padding-left:16px;line-height:1.6">
          ${v.instructionsUsed.map((u) => `<li>${escape(u)}</li>`).join('')}
        </ul>
      `;
      card.append(used);
    }

    const next = h('div', { class: 'row gap-8 mt-8' });
    const goCheck = h('button', { class: 'btn btn-secondary flex1' }, 'Checklist');
    goCheck.addEventListener('click', () => go('checklist', session.id));
    const goResult = h('button', { class: 'btn btn-primary flex1' }, 'Final form →');
    goResult.addEventListener('click', () => go('result', session.id));
    next.append(goCheck, goResult);
    card.append(next);

    return card;
  }

  function footer(): HTMLElement {
    const row = h('div', { class: 'row gap-8 mt-16' });
    const logBtn = h('button', { class: 'btn btn-ghost btn-sm flex1' }, '🛰 Router log');
    logBtn.addEventListener('click', () => openRouterLog());
    row.append(logBtn);
    return row;
  }

  /* ── actions ────────────────────────────────────────────────────────── */

  async function useSampleInstructions(): Promise<void> {
    try {
      const res = await fetch(SAMPLE_INSTRUCTIONS_IMAGE);
      if (!res.ok) throw new Error('sample instructions not served');
      // In DEMO we have the text; in live mode the real model reads the image.
      session.instructionText = SAMPLE_INSTRUCTION_TEXT;
      await saveSession(session, true);
      toast('Sample instructions added', { tone: 'success' });
      paint();
    } catch {
      toast('Sample failed to load', { tone: 'error' });
    }
  }

  async function usePhotoInstructions(file: File): Promise<void> {
    try {
      toast('Reading the instruction page…', { tone: 'info' });
      const processed = await processFile(file, false);

      // The instruction page carries no personal data, so OCR-ing it in the
      // cloud is both safe and better: Nano\'s small-print OCR is weak, and this
      // is exactly the kind of long-text reading the bigger model is for.
      if (state.settings.demoMode) {
        session.instructionText = SAMPLE_INSTRUCTION_TEXT;
        toast('DEMO: sample instructions used', { tone: 'info' });
      } else {
        const { callModel } = await import('../../ai/firebaseAi');
        const { FIREBASE_CONFIG } = await import('../../config/config');
        const out = await callModel(FIREBASE_CONFIG, {
          prompt:
            'Transcribe all instruction text from this scanned Indian form page. Return plain text only, keeping numbering. Do not summarise.',
          image: { base64: processed.base64, mimeType: processed.mimeType },
          prefer: 'cloud',
          temperature: 0,
        });
        session.instructionText = out.text.trim();
        toast('Instructions read', { tone: 'success' });
      }
      await saveSession(session, true);
      paint();
    } catch {
      toast('Instruction page could not be read', { tone: 'error' });
    }
  }

  async function doVerify(): Promise<void> {
    if (running) return;
    running = true;
    paint();
    try {
      const profile = state.settings.demoMode ? state.settings.demoVerifyProfile : undefined;
      const out = await runCloudVerify(session, { demoProfile: profile });
      running = false;
      paint();
      if (out.queued) {
        toast('No internet - verify has been queued. It will run automatically when the network returns.', {
          tone: 'warn',
          ms: 5200,
        });
      } else {
        const issues = out.result.verdicts.filter((v) => v.status !== 'ok').length;
        toast(
          issues > 0 ? `Verify done - ${issues} field(s) need your attention.` : 'Verify done - all clear ✓',
          { tone: issues > 0 ? 'warn' : 'success' },
        );
      }
    } catch (err) {
      running = false;
      paint();
      toast(err instanceof Error ? err.message : 'Verify failed', { tone: 'error' });
    }
  }

  paint();

  // A queued verify can complete in the background (services/sync.ts → the
  // 'online' handler). When that happens the app state notifies, and this
  // screen must show the verdict without the user reloading.
  const unsub = subscribe(() => {
    if (!document.body.contains(screen)) return;
    const knownStatus = session.verifyStatus;
    const knownVerify = session.verify;
    void loadSession(session.id).then((fresh) => {
      if (!fresh || !document.body.contains(screen)) return;
      if (fresh.verifyStatus === knownStatus && fresh.verify === knownVerify) return;
      session = fresh; // adopt the replayed result
      paint();
    });
  });

  return () => unsub();
}

/** Verbatim OCR of the bundled instruction page - used in DEMO MODE so the
 *  verify prompt is built from real instruction text rather than a stub. */
export const SAMPLE_INSTRUCTION_TEXT = `POST MATRIC SCHOLARSHIP 2026-27 - Instructions for filling the application form
1. Eligibility: applicant must belong to SC, ST or OBC category and have an annual family income of Rs. 2,50,000 or less from all sources.
2. Income must be written as ANNUAL family income, in figures only. Do not write monthly income and do not write the amount in words. Applications showing monthly income will be rejected.
3. Date of birth must be in DD/MM/YYYY format exactly as printed on the matriculation certificate.
4. Mobile number must be 10 digits without +91, without spaces and without hyphens. This number receives all OTP and status messages.
5. Aadhaar number, if provided, must be exactly 12 digits. Aadhaar is optional at the application stage but required before disbursal.
6. PIN code must be 6 digits and must match the district and state given in the address.
7. Percentage marks must be in figures only, rounded to two decimal places, and must refer to the last qualifying examination.
8. Bank account must be in the name of the applicant. Joint accounts and minor accounts are not accepted. IFSC code is 11 characters: 4 letters, then 0, then 6 alphanumeric characters.
9. Original documents required at verification: matriculation certificate, income certificate issued by the competent authority, caste certificate, bank passbook first page and last marksheet.
10. Incomplete applications will be rejected without any intimation. The applicant is responsible for the correctness of every entry.
11. Last date for submission: 31 January 2027. Late applications will not be considered.`;

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
}
function escapeHtml(s: string): string {
  return escape(s);
}

export type { FormSession };
export { buildCloudVerifyPrompt };
