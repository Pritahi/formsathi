/**
 * Home / "Home".
 *
 * The first screen has one job: get the user to point a camera at a form in one
 * tap. Everything else on this screen exists to make the hybrid story legible
 * before the user has done anything - the two-column "where it runs" strip
 * and the vault status.
 */

import { h, mount, toast } from '../dom';
import { go } from '../shell';
import { badge, lightCounts } from '../badges';
import { state, subscribe } from '../../store/app';
import { listSessions, deleteSession, lightCounts as countsFor, completion } from '../../services/sessions';
import type { FormSession } from '../../lib/types';
import { hybridSnapshot, ROUTE_TABLE } from '../../ai/router';
import { getAllAnswers } from '../../vault/vault';
import { relTime, confirmSheet } from '../dom';
import { openRouterLog } from '../routerLog';

export async function renderHome(host: HTMLElement): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  const paint = async () => {
    const sessions = await listSessions();
    const vaultRecords = state.vaultUnlocked ? await getAllAnswers() : [];
    const snap = hybridSnapshot();

    screen.replaceChildren(
      hero(),
      state.settings.demoMode ? demoBanner() : liveBanner(snap),
      primaryActions(),
      vaultStrip(vaultRecords.length),
      sessionList(sessions),
      hybridStrip(),
      footerNote(),
    );
  };

  await paint();

  // Re-paint only when something the screen actually shows has changed.
  // Without this, any global notify (Firebase init finishing, pending-count
  // refresh) would replace the DOM under the user's finger mid-tap.
  let signature = '';
  const sign = () =>
    JSON.stringify([
      state.pending,
      state.online,
      state.settings.demoMode,
      state.settings.simulatedOffline,
      state.vaultUnlocked,
      state.vaultPresent,
    ]);
  signature = sign();

  const unsub = subscribe(() => {
    if (!document.body.contains(screen)) return;
    const next = sign();
    if (next === signature) return;
    signature = next;
    void paint();
  });
  return () => unsub();
}

/* ── pieces ───────────────────────────────────────────────────────────── */

function hero(): HTMLElement {
  return h(
    'div',
    { style: 'padding:6px 0 14px' },
    h(
      'p',
      { class: 'text-xs strong', style: 'color:var(--saffron);letter-spacing:.06em;text-transform:uppercase' },
      'Your form-filling helper',
    ),
    h('h1', { class: 'mt-8' }, 'Take a photo of the form. ', h('span', { style: 'color:var(--green-700)' }, 'We will handle the rest.')),
    h(
      'p',
      { class: 'mt-8 muted', style: 'font-size:15px;line-height:1.5' },
      'Adult-developer prototype with fictional sample forms. Demo mode uses mock AI; live cloud accepts only bundled synthetic samples. Personal form photos require real on-device Nano and never fall back to cloud. Answers stay local.',
    ),
  );
}

function demoBanner(): HTMLElement {
  return h(
    'div',
    { class: 'note note-warn mb-16' },
    h('span', { 'aria-hidden': 'true' }, '🧪'),
    h(
      'div',
      {},
      h('b', {}, 'DEMO MODE is on. '),
      'Every AI call comes from a realistic mock - no key, no cost. The Vault is encrypted with real WebCrypto. Turn on live mode from Settings.',
    ),
  );
}

function liveBanner(snap: ReturnType<typeof hybridSnapshot>): HTMLElement {
  const isDevice = snap.deviceSupport === 'available';
  return h(
    'div',
    { class: `note ${isDevice ? 'note-ok' : ''} mb-16` },
    h('span', { 'aria-hidden': 'true' }, isDevice ? '⚡' : '☁️'),
    h(
      'div',
      {},
      h('b', {}, isDevice ? 'On-device ready. ' : 'Synthetic-sample cloud path. '),
      snap.deviceReason,
    ),
  );
}

function primaryActions(): HTMLElement {
  const camera = h(
    'button',
    { class: 'btn btn-primary btn-lg btn-block' },
    h('span', { 'aria-hidden': 'true' }, '📷'),
    'Take a photo of the form',
  );
  camera.addEventListener('click', () => go('intake', 'photo'));

  const upload = h(
    'button',
    { class: 'btn btn-secondary btn-block mt-8' },
    h('span', { 'aria-hidden': 'true' }, '🖼️'),
    'Choose a photo or PDF from gallery',
  );
  upload.addEventListener('click', () => go('intake', 'upload'));

  const sample = h(
    'button',
    { class: 'btn btn-ghost btn-block mt-8' },
    h('span', { 'aria-hidden': 'true' }, '🎬'),
    'See the demo with a sample form (no camera)',
  );
  sample.addEventListener('click', () => go('intake', 'samples'));

  return h('div', { class: 'mb-16' }, camera, upload, sample);
}

function vaultStrip(count: number): HTMLElement {
  const locked = !state.vaultUnlocked;
  const card = h('button', { class: 'card card-tap mb-16' });
  card.innerHTML = `
    <div class="row between">
      <div class="row gap-8">
        <span class="avatar" aria-hidden="true">🔐</span>
        <div>
          <div class="card-title">Answer Vault</div>
          <div class="text-xs muted">${
            !state.vaultPresent
              ? 'Not created yet - create it in 30 seconds'
              : locked
                ? 'Locked - unlock to reuse old answers'
                : `${count} answers saved - the next form will fill right away`
          }</div>
        </div>
      </div>
      <span class="text-xs strong" style="color:var(--green-700)">${locked ? 'Open →' : 'View →'}</span>
    </div>
  `;
  card.addEventListener('click', () => go('vault'));
  return card;
}

function sessionList(sessions: FormSession[]): HTMLElement {
  const wrap = h('div', { class: 'col gap-8 mb-16' });
  wrap.append(h('h2', { style: 'font-size:15px;margin-bottom:2px' }, 'Your forms'));

  if (sessions.length === 0) {
    wrap.append(
      h(
        'div',
        { class: 'card empty' },
        h('span', { class: 'ic' }, '📄'),
        h('div', { class: 'text-sm' }, 'No forms yet.'),
        h('div', { class: 'text-xs muted mt-2' }, 'Start your first form with the button above.'),
      ),
    );
    return wrap;
  }

  for (const s of sessions.slice(0, 6)) {
    const counts = countsFor(s);
    const pct = Math.round(completion(s) * 100);
    const row = h('div', { class: 'card card-tap' });
    row.innerHTML = `
      <div class="row between gap-8">
        <div style="min-width:0">
          <div class="card-title truncate">${escape(s.title)}</div>
          <div class="text-xs muted mt-2">${relTime(s.updatedAt)} · ${s.extraction?.fields.length ?? 0} fields · ${pct}% filled</div>
        </div>
        ${lightCounts(counts)}
      </div>
      <div class="progress mt-8"><i style="width:${pct}%"></i></div>
      <div class="row wrap gap-6 mt-8">
        ${s.verifyStatus === 'queued' ? badge({ kind: 'queued', small: true, label: 'Verify queue' }) : ''}
        ${s.verify ? badge({ kind: 'cloud', small: true, label: `${s.verify.verdicts.filter((v) => v.status !== 'ok').length} flags` }) : ''}
        ${s.extraction ? badge({ kind: 'on-device', small: true, label: 'Fields ready' }) : ''}
      </div>
    `;
    const id = s.id;
    row.addEventListener('click', () => {
      if (!s.extraction) go('intake', 'upload');
      else if (pct < 100) go('interview', id);
      else go('checklist', id);
    });

    const del = h('button', { class: 'icon-btn sm ghost', 'aria-label': 'Delete form', title: 'Delete' }, '🗑');
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await confirmSheet({
        title: 'Delete form?',
        message: `"${s.title}" and its photo will be removed from this phone. Vault answers stay safe.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok) {
        await deleteSession(id);
        toast('Form deleted');
        void go('home');
        location.reload();
      }
    });
    row.querySelector('.row')?.append(del);
    wrap.append(row);
  }
  return wrap;
}

function hybridStrip(): HTMLElement {
  const card = h('div', { class: 'card-flat mb-16' });
  const onDevice = (Object.keys(ROUTE_TABLE) as Array<keyof typeof ROUTE_TABLE>).filter(
    (t) => ROUTE_TABLE[t].path === 'on-device',
  );
  const cloud = (Object.keys(ROUTE_TABLE) as Array<keyof typeof ROUTE_TABLE>).filter(
    (t) => ROUTE_TABLE[t].path === 'cloud',
  );
  card.innerHTML = `
    <div class="row between">
      <b class="text-sm">How this app works</b>
      <button class="text-xs strong" style="background:none;border:0;color:var(--green-700);cursor:pointer" id="open-log">Router log →</button>
    </div>
    <div class="row gap-8 mt-8 wrap">
      <div class="stat" style="border-color:#bfe0cc;background:var(--green-100)">
        <div class="n" style="color:var(--green-800)">${onDevice.length}</div>
        <div class="l">intended local routes</div>
      </div>
      <div class="stat" style="border-color:#c7ddf5;background:var(--blue-100)">
        <div class="n" style="color:#14528f">${cloud.length}</div>
        <div class="l">planned cloud routes</div>
      </div>
    </div>
    <p class="text-xs muted mt-8">
      Demo mode simulates AI. Live personal content never falls back to cloud. Without Nano, questions and answer mapping use local rules. Cloud verification of personal forms is blocked; synthetic cloud extraction is verified; real Nano is not yet verified.
    </p>
  `;
  card.querySelector('#open-log')?.addEventListener('click', () => openRouterLog());
  return card;
}

function footerNote(): HTMLElement {
  return h(
    'p',
    { class: 'text-2xs muted-2 center-text', style: 'line-height:1.6' },
    'FormSathi does not submit to any government portal on its own. ',
    'It gives you a filled form - you submit it yourself. ',
    'No Aadhaar authentication happens.',
  );
}

function escape(s: string): string {
  return s.replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
}

export { mount };
