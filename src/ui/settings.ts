/**
 * Settings sheet.
 *
 * Three jobs:
 *  1. the DEMO MODE toggle (the thing that makes this app runnable with no keys)
 *  2. the simulated-airplane-mode switch (so the offline story is demoable on a
 *     laptop without touching the OS wifi)
 *  3. diagnostics: what the capability probe found, what Firebase state is, what
 *     voices exist, how much storage the vault takes.
 *
 * Nothing here is hidden behind a "developer" flag. A judge should be able to
 * open one sheet and see the whole machine.
 */

import { h, openSheet, toast, confirmSheet } from './dom';
import { state, saveSettings, notify } from '../store/app';
import {
  routerState,
  refreshCapability,
  hybridSnapshot,
  downloadOnDeviceModel,
  clearRouterLog,
} from '../ai/router';
import { firebaseStatusLabel } from '../services/firebase';
import { activeVoiceLabel, voiceInputSupported, voiceOutputSupported } from '../lib/voice';
import { getQueue, flushQueue } from '../services/sync';
import { storageEstimate, idb, STORE } from '../lib/idb';
import { formatBytes } from '../lib/util';
import { openRouterLog } from './routerLog';
import { APP_VERSION } from '../config/config';
import { listSessions } from '../services/sessions';

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function section(title: string): HTMLElement {
  return h(
    'h3',
    { class: 'text-2xs strong muted', style: 'text-transform:uppercase;letter-spacing:.06em;margin-top:4px' },
    title,
  );
}

function toggleRow(
  label: string,
  desc: string,
  value: boolean,
  onChange: (v: boolean) => void | Promise<void>,
): HTMLElement {
  const row = h('div', {
    class: 'card-tight',
    style: 'display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:12px',
  });
  const text = h('div', { style: 'flex:1;min-width:0' });
  text.innerHTML = `<div class="strong text-sm">${escape(label)}</div><div class="text-2xs muted mt-2">${escape(desc)}</div>`;

  const sw = h('button', {
    role: 'switch',
    'aria-checked': String(value),
    'aria-label': label,
    style: `width:52px;height:30px;border-radius:999px;border:0;cursor:pointer;flex:none;position:relative;background:${
      value ? 'var(--green-700)' : 'var(--line-strong)'
    };transition:background .2s`,
  });
  sw.append(
    h('span', {
      style: `position:absolute;top:3px;left:${value ? '25px' : '3px'};width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .2s`,
    }),
  );
  sw.addEventListener('click', () => void onChange(!value));
  row.append(text, sw);
  return row;
}

function chipRow<T extends string>(
  options: Array<{ k: T; l: string }>,
  current: T,
  onPick: (k: T) => void | Promise<void>,
): HTMLElement {
  const row = h('div', { class: 'row wrap gap-6 mt-8' });
  for (const o of options) {
    const chip = h(
      'button',
      {
        class: 'chip',
        style: 'font-size:12.5px;min-height:32px;padding:5px 11px',
        'aria-pressed': String(current === o.k),
      },
      o.l,
    );
    chip.addEventListener('click', () => void onPick(o.k));
    row.append(chip);
  }
  return row;
}

export function openSettings(): void {
  const body = h('div', { class: 'col gap-14' });
  const sheet = openSheet({
    title: 'Settings',
    subtitle: `FormSathi v${APP_VERSION}`,
    body,
  });

  const demoProfileCard = (): HTMLElement => {
    const wrap = h('div', {
      class: 'card-tight',
      style: 'border:1px solid var(--line);border-radius:12px',
    });
    wrap.append(
      h('div', { class: 'strong text-sm' }, 'Demo galti (cloud verify ke liye)'),
      h('div', { class: 'text-2xs muted mt-2' }, 'Verify ko batayein kaunsi galti pakadni hai.'),
      chipRow(
        [
          { k: 'income-monthly', l: 'monthly income' },
          { k: 'plus91', l: '+91 mobile' },
          { k: 'wrong-ifsc', l: 'galat IFSC' },
          { k: 'clean', l: 'sab theek' },
        ],
        state.settings.demoVerifyProfile,
        async (k) => {
          await saveSettings({ demoVerifyProfile: k });
          await paint();
        },
      ),
    );
    return wrap;
  };

  const deviceCard = (): HTMLElement => {
    const cap = routerState.capability;
    const snap = hybridSnapshot();
    const d = h('div', { class: 'card-flat' });
    d.innerHTML = `<dl class="kv">
      <dt>Support</dt><dd>${escape(cap?.support ?? 'check nahi hua')}</dd>
      <dt>Browser</dt><dd>${escape(cap?.detail.browser ?? '—')}${cap?.detail.chromiumMajor ? ` v${cap.detail.chromiumMajor}` : ''}</dd>
      <dt>Desktop</dt><dd>${cap?.detail.isDesktop ? 'haan' : 'nahi'}</dd>
      <dt>Prompt API</dt><dd>${cap?.detail.hasPromptApi ? 'mil gaya' : 'nahi hai'}</dd>
      <dt>HTTPS</dt><dd>${cap?.detail.secureContext ? 'haan' : 'nahi'}</dd>
      <dt>On-device calls</dt><dd>${snap.onDeviceCalls}</dd>
      <dt>Cloud calls</dt><dd>${snap.cloudCalls}</dd>
    </dl>
    <p class="text-2xs muted mt-8">${escape(cap?.reason ?? '')}</p>`;

    const row = h('div', { class: 'row gap-8 mt-12' });
    const probe = h('button', { class: 'btn btn-secondary btn-sm flex1' }, '🔄 Dobara check');
    probe.addEventListener('click', async () => {
      await refreshCapability(true);
      toast('Check ho gaya');
      await paint();
    });
    const dl = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ Nano download');
    dl.addEventListener('click', async () => {
      try {
        await downloadOnDeviceModel((p) => {
          if (p >= 1) toast('Model ready', { tone: 'success' });
        });
        await paint();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Download fail', { tone: 'error' });
      }
    });
    row.append(probe, dl);
    d.append(row);
    return d;
  };

  const dataCard = (queueLen: number, storage: { usage: number; quota: number } | null, sessionCount: number, vaultCount: number): HTMLElement => {
    const d = h('div', {});
    d.innerHTML = `<dl class="kv">
      <dt>Form sessions</dt><dd>${sessionCount}</dd>
      <dt>Vault records</dt><dd>${vaultCount} (encrypted)</dd>
      <dt>Storage use</dt><dd>${storage ? `${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}` : '—'}</dd>
      <dt>Pending queue</dt><dd>${queueLen}</dd>
      <dt>Firebase</dt><dd>${escape(firebaseStatusLabel())}</dd>
      <dt>Uid</dt><dd class="mono">${escape(state.firebase.uid ?? '—')}</dd>
    </dl>`;
    const row = h('div', { class: 'row wrap gap-8 mt-12' });
    const flush = h('button', { class: 'btn btn-secondary btn-sm' }, '⏳ Queue ab chalayein');
    flush.addEventListener('click', async () => {
      const r = await flushQueue();
      toast(`${r.ran} task chalaye, ${r.ok} safal`, { tone: r.ok ? 'success' : 'warn' });
      await paint();
    });
    const clear = h('button', { class: 'btn btn-ghost btn-sm' }, '📋 Log clear karein');
    clear.addEventListener('click', async () => {
      clearRouterLog();
      toast('Router log clear');
      await paint();
    });
    row.append(flush, clear);
    d.append(row);
    return d;
  };

  const aboutCard = (): HTMLElement => {
    const d = h('div', {});
    d.innerHTML = `<p class="text-xs muted" style="line-height:1.6">
      FormSathi — #BuildHybridAI 2026 ke liye bana. Firebase AI Logic ka hybrid inference:
      on-device Gemini Nano (Chrome Prompt API) aur cloud Gemini, ek hi API surface se.
    </p>
    <dl class="kv mt-8">
      <dt>Version</dt><dd>${APP_VERSION}</dd>
      <dt>Licence</dt><dd>MIT</dd>
      <dt>Cloud</dt><dd>Firebase Spark free tier only</dd>
    </dl>`;
    const row = h('div', { class: 'row gap-8 mt-12' });
    const log = h('button', { class: 'btn btn-primary btn-sm flex1' }, '🛰 Router log kholein');
    log.addEventListener('click', () => {
      sheet.close();
      openRouterLog();
    });
    const wipe = h('button', { class: 'btn btn-danger btn-sm' }, '🗑 Sab mitayein');
    wipe.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Sab data mitayein?',
        message:
          'Saare forms, photos aur sessions is phone se hat jayenge. Vault alag se mitana padta hai (Vault screen par).',
        confirmLabel: 'Sab mitayein',
        danger: true,
      });
      if (!ok) return;
      await idb.clear(STORE.sessions);
      await idb.clear(STORE.images);
      toast('Forms mit gaye');
      notify();
      await paint();
    });
    row.append(log, wipe);
    d.append(row);
    return d;
  };

  const paint = async (): Promise<void> => {
    const queue = await getQueue();
    const storage = await storageEstimate();
    const sessions = await listSessions();
    const vaultCount = await idb.keys(STORE.vault).catch(() => []);

    body.replaceChildren(
      section('Demo aur mode'),
      toggleRow(
        'DEMO MODE',
        'Mock models chalayein — koi Firebase key nahi chahiye',
        state.settings.demoMode,
        async (v) => {
          await saveSettings({ demoMode: v });
          toast(v ? 'Demo mode on — sab AI calls mock se' : 'Live mode on — Firebase AI Logic use hoga', {
            tone: 'info',
          });
          await paint();
        },
      ),
      demoProfileCard(),

      section('Network'),
      toggleRow(
        'Airplane mode (simulate)',
        'Offline-first demo ke liye — app waise hi chalega jaise net bina',
        state.settings.simulatedOffline,
        async (v) => {
          await saveSettings({ simulatedOffline: v });
          toast(v ? '✈️ Offline mode on — form bharna chalta rahega' : 'Online mode on', {
            tone: v ? 'warn' : 'success',
          });
          await paint();
        },
      ),
      h(
        'p',
        { class: 'text-2xs muted' },
        'Yeh browser ko offline nahi karta — sirf app ke cloud calls rok deta hai aur queue on kar deta hai. Asli airplane mode se bhi same behaviour milta hai.',
      ),

      section('Awaaz'),
      toggleRow(
        'Sawaal bolein (voice out)',
        `Voice: ${activeVoiceLabel()}`,
        state.settings.voiceOutput && voiceOutputSupported(),
        async (v) => {
          await saveSettings({ voiceOutput: v });
          toast(v ? 'Sawaal bol kar sunaye jayenge' : 'Voice off', { tone: 'info' });
          await paint();
        },
      ),
      toggleRow(
        'Mic se jawab (voice in)',
        voiceInputSupported()
          ? 'Web Speech API — browser ka apna engine'
          : 'Is browser mein voice input nahi hai',
        state.settings.voiceInput && voiceInputSupported(),
        async (v) => {
          await saveSettings({ voiceInput: v });
          await paint();
        },
      ),

      section('On-device model'),
      deviceCard(),

      section('Data aur storage'),
      dataCard(queue.length, storage, sessions.length, vaultCount.length),

      section('Iske baare mein'),
      aboutCard(),
    );
  };

  void paint();
}
