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
  return String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
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
      h('div', { class: 'strong text-sm' }, 'Demo mistake (for cloud verify)'),
      h('div', { class: 'text-2xs muted mt-2' }, 'Tell verify which mistake to catch.'),
      chipRow(
        [
          { k: 'income-monthly', l: 'monthly income' },
          { k: 'plus91', l: '+91 mobile' },
          { k: 'wrong-ifsc', l: 'wrong IFSC' },
          { k: 'clean', l: 'all fine' },
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
    d.innerHTML = `<dl class=\"kv\">
      <dt>Support</dt><dd>${escape(cap?.support ?? 'not checked yet')}</dd>
      <dt>Browser</dt><dd>${escape(cap?.detail.browser ?? '-')}${cap?.detail.chromiumMajor ? ` v${cap.detail.chromiumMajor}` : ''}</dd>
      <dt>Desktop</dt><dd>${cap?.detail.isDesktop ? 'yes' : 'no'}</dd>
      <dt>Prompt API</dt><dd>${cap?.detail.hasPromptApi ? 'available' : 'not available'}</dd>
      <dt>HTTPS</dt><dd>${cap?.detail.secureContext ? 'yes' : 'no'}</dd>
      <dt>On-device calls</dt><dd>${snap.onDeviceCalls}</dd>
      <dt>Cloud calls</dt><dd>${snap.cloudCalls}</dd>
    </dl>
    <p class="text-2xs muted mt-8">${escape(cap?.reason ?? '')}</p>`;

    const row = h('div', { class: 'row gap-8 mt-12' });
    const probe = h('button', { class: 'btn btn-secondary btn-sm flex1' }, '🔄 Check again');
    probe.addEventListener('click', async () => {
      await refreshCapability(true);
      toast('Check done');
      await paint();
    });
    const dl = h('button', { class: 'btn btn-ghost btn-sm' }, '⬇️ Download Nano');
    dl.addEventListener('click', async () => {
      try {
        await downloadOnDeviceModel((p) => {
          if (p >= 1) toast('Model ready', { tone: 'success' });
        });
        await paint();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Download failed', { tone: 'error' });
      }
    });
    row.append(probe, dl);
    d.append(row);
    return d;
  };

  const dataCard = (queueLen: number, storage: { usage: number; quota: number } | null, sessionCount: number, vaultCount: number): HTMLElement => {
    const d = h('div', {});
    d.innerHTML = `<dl class=\"kv\">
      <dt>Form sessions</dt><dd>${sessionCount}</dd>
      <dt>Vault records</dt><dd>${vaultCount} (encrypted)</dd>
      <dt>Storage use</dt><dd>${storage ? `${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}` : '-'}</dd>
      <dt>Pending queue</dt><dd>${queueLen}</dd>
      <dt>Firebase</dt><dd>${escape(firebaseStatusLabel())}</dd>
      <dt>Uid</dt><dd class="mono">${escape(state.firebase.uid ?? '-')}</dd>
    </dl>`;
    const row = h('div', { class: 'row wrap gap-8 mt-12' });
    const flush = h('button', { class: 'btn btn-secondary btn-sm' }, '⏳ Run queue now');
    flush.addEventListener('click', async () => {
      const r = await flushQueue();
      toast(`${r.ran} tasks ran, ${r.ok} succeeded`, { tone: r.ok ? 'success' : 'warn' });
      await paint();
    });
    const clear = h('button', { class: 'btn btn-ghost btn-sm' }, '📋 Clear log');
    clear.addEventListener('click', async () => {
      clearRouterLog();
      toast('Router log cleared');
      await paint();
    });
    row.append(flush, clear);
    d.append(row);
    return d;
  };

  const aboutCard = (): HTMLElement => {
    const d = h('div', {});
    d.innerHTML = `<p class="text-xs muted" style="line-height:1.6">
      FormSathi - built for #BuildHybridAI 2026. Firebase AI Logic hybrid inference:
      on-device Gemini Nano (Chrome Prompt API) and cloud Gemini, one API surface.
    </p>
    <dl class="kv mt-8">
      <dt>Version</dt><dd>${APP_VERSION}</dd>
      <dt>Licence</dt><dd>MIT</dd>
      <dt>Cloud</dt><dd>Firebase Spark free tier only</dd>
    </dl>`;
    const row = h('div', { class: 'row gap-8 mt-12' });
    const log = h('button', { class: 'btn btn-primary btn-sm flex1' }, '🛰 Open router log');
    log.addEventListener('click', () => {
      sheet.close();
      openRouterLog();
    });
    const wipe = h('button', { class: 'btn btn-danger btn-sm' }, '🗑 Wipe everything');
    wipe.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Wipe all data?',
        message:
          'All forms, photos and sessions will be removed from this phone. The vault must be wiped separately (on the Vault screen).',
        confirmLabel: 'Wipe everything',
        danger: true,
      });
      if (!ok) return;
      await idb.clear(STORE.sessions);
      await idb.clear(STORE.images);
      toast('Forms wiped');
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
      section('Demo and mode'),
      toggleRow(
        'DEMO MODE',
        'Run mock models - no Firebase key needed',
        state.settings.demoMode,
        async (v) => {
          await saveSettings({ demoMode: v });
          toast(v ? 'Demo mode on - all AI calls are mocked' : 'Live mode on - Firebase AI Logic will be used', {
            tone: 'info',
          });
          await paint();
        },
      ),
      demoProfileCard(),

      section('Network'),
      toggleRow(
        'Airplane mode (simulate)',
        'For the offline-first demo - the app works as if there is no network',
        state.settings.simulatedOffline,
        async (v) => {
          await saveSettings({ simulatedOffline: v });
          toast(v ? '✈️ Offline mode on - form filling continues' : 'Online mode on', {
            tone: v ? 'warn' : 'success',
          });
          await paint();
        },
      ),
      h(
        'p',
        { class: 'text-2xs muted' },
        'This does not take the browser offline - it only stops the app\'s cloud calls and turns the queue on. Real airplane mode behaves the same.',
      ),

      section('Voice'),
      toggleRow(
        'Speak questions (voice out)',
        `Voice: ${activeVoiceLabel()}`,
        state.settings.voiceOutput && voiceOutputSupported(),
        async (v) => {
          await saveSettings({ voiceOutput: v });
          toast(v ? 'Questions will be spoken aloud' : 'Voice off', { tone: 'info' });
          await paint();
        },
      ),
      toggleRow(
        'Answer by mic (voice in)',
        voiceInputSupported()
          ? 'Web Speech API - the browser\'s own engine'
          : 'This browser has no voice input',
        state.settings.voiceInput && voiceInputSupported(),
        async (v) => {
          await saveSettings({ voiceInput: v });
          await paint();
        },
      ),

      section('On-device model'),
      deviceCard(),

      section('Data and storage'),
      dataCard(queue.length, storage, sessions.length, vaultCount.length),

      section('About'),
      aboutCard(),
    );
  };

  void paint();
}

