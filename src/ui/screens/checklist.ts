/**
 * Checklist — where the traffic lights live (MVP feature 7).
 *
 * One row per extracted field: label, value, light, provenance badge, and the
 * cloud flag reason when there is one. Tapping a row opens an editor. This is
 * also where the source image overlay can be inspected field by field, which is
 * how a user verifies that extraction got the right box.
 *
 * Deliberately not a "table": at 360px a table becomes unreadable, and this app
 * is designed at 360px first.
 */

import { h, toast, openSheet, confirmSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badge, light, lightCounts } from '../badges';
import { subscribe } from '../../store/app';
import {
  loadSession,
  loadImageBlob,
  saveSession,
  computeLight,
  lightCounts as countsFor,
  completion,
  deleteSession,
} from '../../services/sessions';
import type { Answer, FormSession } from '../../lib/types';
import { InterviewEngine } from '../../services/interview';
import { buildAnswerSheet, copyText, downloadText, sheetFilename } from '../../services/export';

export async function renderChecklist(host: HTMLElement, sessionId?: string): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  if (!sessionId) {
    screen.append(h('div', { class: 'card empty' }, 'Form nahi mila.'));
    return () => {};
  }
  const loaded = await loadSession(sessionId);
  if (!loaded || !loaded.extraction) {
    screen.append(
      screenHeader({ title: 'Checklist', back: () => go('home') }),
      h('div', { class: 'card empty' }, h('span', { class: 'ic' }, '📄'), 'Yeh form nahi mila.'),
      h('button', { class: 'btn btn-primary btn-block mt-16', onclick: () => go('intake', 'photo') }, 'Naya form'),
    );
    return () => {};
  }
  // `let` so a background queue replay can swap in the updated session.
  let session: FormSession = loaded;

  const engine = new InterviewEngine(session, {
    onTurn: () => {},
    onAnswer: () => {},
    onDone: () => {},
    onError: (m) => toast(m, { tone: 'error' }),
  });

  const flaggedIds = new Set(
    (session.verify?.verdicts ?? []).filter((v) => v.status !== 'ok').map((v) => v.fieldId),
  );

  let filter: 'all' | 'red' | 'yellow' | 'green' = 'all';

  const paint = (): void => {
    const counts = countsFor(session);
    const pct = Math.round(completion(session) * 100);
    screen.replaceChildren(
      screenHeader({
        title: 'Field checklist',
        subtitle: `${session.extraction!.fields.length} fields · ${pct}% bhara`,
        back: () => go('home'),
        right: (() => {
          const b = h('div', { class: 'row gap-6' });
          b.innerHTML = lightCounts(counts);
          return b;
        })(),
      }),
      actionRow(),
      filterRow(),
      fieldList(),
      bottomActions(),
      privacyNote(),
    );
  };

  function actionRow(): HTMLElement {
    const row = h('div', { class: 'row gap-8 mb-16' });
    const verifyBtn = h('button', { class: 'btn btn-primary flex1' });
    verifyBtn.innerHTML =
      session.verifyStatus === 'queued'
        ? '⏳ Verify queue mein'
        : session.verifyStatus === 'done'
          ? '☁️ Dobara verify karein'
          : '☁️ Cloud verify chalayein';
    verifyBtn.addEventListener('click', () => go('verify', session.id));
    const resultBtn = h('button', { class: 'btn btn-secondary btn-sm' }, '📄 Answer sheet');
    resultBtn.addEventListener('click', () => go('result', session.id));
    row.append(verifyBtn, resultBtn);
    return row;
  }

  function filterRow(): HTMLElement {
    const wrap = h('div', { class: 'pill-tabs mb-12' });
    const opts: Array<{ k: typeof filter; label: string }> = [
      { k: 'all', label: 'Sab' },
      { k: 'red', label: 'Khali' },
      { k: 'yellow', label: 'Dekh lein' },
      { k: 'green', label: 'Theek' },
    ];
    for (const o of opts) {
      const b = h('button', { class: 'pill-tab', 'aria-selected': String(filter === o.k) }, o.label);
      b.addEventListener('click', () => {
        filter = o.k;
        paint();
      });
      wrap.append(b);
    }
    return wrap;
  }

  function fieldList(): HTMLElement {
    const list = h('div', { class: 'col gap-8' });
    const fields = session.extraction!.fields;

    const rows = fields
      .map((f) => {
        const a = session.answers[f.id];
        const lightVal = computeLight(f, a, { cloudFlagged: flaggedIds.has(f.id) });
        return { f, a, lightVal };
      })
      .filter((r) => filter === 'all' || r.lightVal === filter);

    if (rows.length === 0) {
      list.append(h('div', { class: 'card empty' }, h('div', { class: 'text-sm' }, 'Is filter mein koi field nahi.')));
      return list;
    }

    for (const { f, a, lightVal } of rows) {
      const row = h('button', { class: `field-row field-${lightVal}` });
      const valueHtml = a?.value
        ? `<div class="val">${escape(f.type === 'date' ? ddmm(a.value) : a.value)}</div>`
        : `<div class="val muted-2">— khali${f.required ? ' (zaroori)' : ''} —</div>`;

      row.innerHTML = `
        <div class="row" style="padding-top:2px">${light(lightVal, { size: 'sm' })}</div>
        <div style="flex:1;min-width:0">
          <div class="lbl">${escape(f.label)}${f.required ? ' <span style="color:var(--red)">*</span>' : ''}</div>
          ${valueHtml}
          ${
            a?.flagReason
              ? `<div class="text-2xs mt-2" style="color:var(--amber)">⚠️ ${escape(a.flagReason)}</div>`
              : ''
          }
          ${
            a?.note
              ? `<div class="text-2xs muted mt-2">${escape(a.note)}</div>`
              : ''
          }
          <div class="row wrap gap-4 mt-2">
            ${a?.source === 'vault' ? badge({ kind: 'on-device', small: true, label: 'Vault' }) : ''}
            ${a?.cloudVerified ? badge({ kind: 'cloud', small: true }) : ''}
            ${a?.suggestion ? `<span class="badge badge-fallback badge-sm"><span class="badge-ic">💡</span><span class="badge-tx">sudhar available</span></span>` : ''}
          </div>
        </div>
        <span aria-hidden="true" style="color:var(--ink-4)">›</span>
      `;
      row.addEventListener('click', () => openFieldEditor(f.id));
      list.append(row);
    }
    return list;
  }

  function openFieldEditor(fieldId: string): void {
    const field = session.extraction!.fields.find((f) => f.id === fieldId);
    if (!field) return;
    const a = session.answers[fieldId];
    const verdict = session.verify?.verdicts.find((v) => v.fieldId === fieldId);

    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <div>
        <div class="label">Field</div>
        <div class="strong text-sm">${escape(field.label)}</div>
        <div class="text-xs muted mt-2">${field.type}${field.required ? ' · zaroori' : ' · optional'}${field.hint ? ` · ${escape(field.hint)}` : ''}</div>
      </div>
      ${
        verdict && verdict.status !== 'ok'
          ? `<div class="note note-warn"><span>⚠️</span><div><b>Cloud verify:</b> ${escape(verdict.reason ?? '')}${
              verdict.rule ? `<br/><span class="text-2xs muted">Rule: ${escape(verdict.rule)}</span>` : ''
            }</div></div>`
          : ''
      }
      ${
        verdict?.suggestedValue
          ? `<button class="btn btn-saffron btn-sm" data-suggest>✨ Sudhar apnaayein: ${escape(verdict.suggestedValue)}</button>`
          : ''
      }
    `;

    const label = document.createElement('label');
    label.className = 'label';
    label.textContent = 'Jawab';

    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.type === 'select' && field.options?.length) {
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.innerHTML = `<option value="">— chunein —</option>${field.options
        .map((o) => `<option ${a?.value === o ? 'selected' : ''}>${escape(o)}</option>`)
        .join('')}`;
      input = sel;
    } else if (field.type === 'checkbox') {
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.innerHTML = `<option value="">— chunein —</option><option ${a?.value ? 'selected' : ''}>Yes</option>`;
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.className = 'input';
      inp.type = field.type === 'date' ? 'date' : field.type === 'number' || field.type === 'phone' ? 'tel' : 'text';
      inp.inputMode = field.type === 'number' ? 'numeric' : field.type === 'phone' ? 'tel' : 'text';
      inp.value = field.type === 'date' ? isoFromDdmm(a?.value ?? '') : (a?.value ?? '');
      inp.placeholder = field.type === 'date' ? '' : 'Yahan likhein';
      input = inp;
    }
    body.append(label, input);

    const meta = h('dl', { class: 'kv mt-8' });
    meta.innerHTML = `
      <dt>Light</dt><dd>${light(computeLight(field, a, { cloudFlagged: flaggedIds.has(fieldId) }), { withLabel: true })}</dd>
      <dt>Source</dt><dd>${a?.source ?? '—'}</dd>
      <dt>Author</dt><dd>${a?.author ?? '—'}</dd>
      <dt>Confidence</dt><dd>${a ? `${Math.round(a.confidence * 100)}%` : '—'}</dd>
    `;
    body.append(meta);

    const footer = h('div', { class: 'row gap-8' });
    const save = h('button', { class: 'btn btn-primary flex1' }, 'Save karein');
    const sheet = openSheet({ title: 'Field theek karein', body, footer });

    save.addEventListener('click', async () => {
      const raw = input.value.trim();
      const value = field.type === 'date' ? ddmmToIso(raw) : raw;
      await engine.setAnswerValue(fieldId, value);
      // A manual edit clears the cloud flag for that field: the user has looked.
      if (session.verify) {
        session.verify.verdicts = session.verify.verdicts.filter((v) => v.fieldId !== fieldId);
      }
      if (value) flaggedIds.delete(fieldId);
      await saveSession(session, true);
      sheet.close();
      paint();
      toast('Save ho gaya', { tone: 'success', ms: 1600 });
    });

    body.querySelector('[data-suggest]')?.addEventListener('click', async () => {
      if (!verdict?.suggestedValue) return;
      await engine.acceptSuggestion(fieldId, verdict.suggestedValue);
      flaggedIds.delete(fieldId);
      if (session.verify) session.verify.verdicts = session.verify.verdicts.filter((v) => v.fieldId !== fieldId);
      await saveSession(session, true);
      sheet.close();
      paint();
      toast('Sudhar lag gaya ✓', { tone: 'success' });
    });

    footer.append(save);
  }

  function bottomActions(): HTMLElement {
    const wrap = h('div', { class: 'action-bar' });
    const sheetBtn = h('button', { class: 'btn btn-secondary flex1' }, '📋 Copy');
    sheetBtn.addEventListener('click', async () => {
      const ok = await copyText(buildAnswerSheet(session));
      toast(ok ? 'Answer sheet copy ho gayi' : 'Copy nahi ho paya', { tone: ok ? 'success' : 'error' });
    });
    const dl = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️');
    dl.title = 'Answer sheet download';
    dl.addEventListener('click', () => {
      downloadText(buildAnswerSheet(session), sheetFilename(session));
      toast('Download shuru', { tone: 'success' });
    });
    const img = h('button', { class: 'btn btn-ghost btn-sm' }, '🖼');
    img.title = 'Form overlay dekhein';
    img.addEventListener('click', () => void openOverlay());
    const del = h('button', { class: 'btn btn-ghost btn-sm' }, '🗑');
    del.title = 'Form delete';
    del.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Form delete karein?',
        message: 'Form, photo aur iske jawab is phone se hat jayenge. Vault safe rahega.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok) {
        await deleteSession(session.id);
        toast('Delete ho gaya');
        go('home');
      }
    });
    wrap.append(sheetBtn, dl, img, del);
    return wrap;
  }

  async function openOverlay(): Promise<void> {
    const blob = await loadImageBlob(session.id);
    if (!blob) {
      toast('Form ki photo nahi mili', { tone: 'warn' });
      return;
    }
    const url = URL.createObjectURL(blob);
    const body = h('div', {});
    const viewer = h('div', { class: 'viewer' });
    viewer.innerHTML = `<img src="${url}" alt="Form" />`;
    for (const f of session.extraction!.fields) {
      if (!f.box) continue;
      const a = session.answers[f.id];
      const lv = computeLight(f, a, { cloudFlagged: flaggedIds.has(f.id) });
      const b = h('div', {
        class: `box ${lv === 'green' ? '' : lv}`,
        style: `left:${f.box.x * 100}%;top:${f.box.y * 100}%;width:${f.box.w * 100}%;height:${f.box.h * 100}%`,
      });
      b.title = f.label;
      viewer.append(b);
    }
    body.append(viewer);
    body.append(
      h(
        'p',
        { class: 'text-xs muted mt-8' },
        'Rang = traffic light. Har box us field ka hai jo model ne padha — isliye aap check kar sakte hain ki model ne sahi jagah dekhi ya nahi.',
      ),
    );
    const sheet = openSheet({ title: 'Form par jawab', body });
    sheet.root.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('[data-action="sheet-close"]')) URL.revokeObjectURL(url);
    });
  }

  function privacyNote(): HTMLElement {
    return h(
      'p',
      { class: 'text-2xs muted-2 center-text mt-16' },
      'Yeh checklist aapke phone par bani hai. 🔐 = Answer Vault se aaya, ☁️ = cloud ne verify kiya.',
    );
  }

  paint();
  const unsub = subscribe(() => {
    if (!document.body.contains(screen)) return;
    const knownVerify = session.verify;
    const knownStatus = session.verifyStatus;
    void loadSession(session.id).then((fresh) => {
      if (!fresh || !document.body.contains(screen)) return;
      if (fresh.verify === knownVerify && fresh.verifyStatus === knownStatus) return;
      session = fresh;
      paint();
    });
  });

  return () => unsub();
}

function ddmm(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
function ddmmToIso(v: string): string {
  const m = v.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
}
function isoFromDdmm(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ddmmToIso(v);
}
function escape(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export type { Answer, FormSession };
