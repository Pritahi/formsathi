/**
 * Interview - MVP feature 2, the app's centrepiece.
 *
 * Layout: a chat column of question/answer bubbles plus a sticky composer.
 * The composer adapts to what the field expects (choice chips, numeric keypad,
 * date). Voice input is offered when the browser supports it; voice output
 * reads each question aloud when enabled.
 *
 * The screen is thin on purpose: all state lives in InterviewEngine, so a
 * reload mid-interview resumes from the packed state with no server involved.
 */

import { h, toast, openSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badgeForLog, badge, light, provenanceLine, lightCounts } from '../badges';
import { InterviewEngine } from '../../services/interview';
import { loadSession, loadImageBlob, saveSession, computeLight, lightCounts as countsFor, completion } from '../../services/sessions';
import { state, subscribe } from '../../store/app';
import { startListening, voiceInputSupported, speak, stopSpeaking } from '../../lib/voice';
import { routerState } from '../../ai/router';
import type { Answer, FormSession, InterviewTurn } from '../../lib/types';
import { getLastRouteLog } from '../../ai/logCursor';

export async function renderInterview(host: HTMLElement, sessionId?: string): Promise<() => void> {
  const screen = h('div', { class: 'screen', style: 'padding-bottom:8px' });
  host.append(screen);

  if (!sessionId) {
    screen.append(emptyState());
    return () => {};
  }
  const loaded = await loadSession(sessionId);
  if (!loaded || !loaded.extraction) {
    screen.append(emptyState('This form was not found. Start over.'));
    return () => {};
  }
  const session: FormSession = loaded;

  type Bubble = {
    role: 'bot' | 'user';
    text: string;
    turn?: InterviewTurn;
    light?: 'green' | 'yellow' | 'red';
    fieldLabel?: string;
    /** Collapsed vault prefill group (rendered as one card, not 15 bubbles). */
    prefill?: number;
  };
  const messages: Bubble[] = [];
  let prefillCount = 0;
  let currentTurn: InterviewTurn | null = null;
  let listening: { stop(): void } | null = null;
  let freeze = false;

  const engine = new InterviewEngine(session, {
    onTurn: (turn) => {
      currentTurn = turn;
      messages.push({ role: 'bot', text: turn.question, turn });
      paint();
      if (state.settings.voiceOutput && !turn.done) speak(turn.question);
      if (turn.done) {
        setTimeout(() => openDoneSheet(), 700);
      }
    },
    onAnswer: (fieldId, answer) => {
      const field = session.extraction?.fields.find((f) => f.id === fieldId);
      // Vault prefill is not a conversation - it is one "look, already done"
      // moment. Rendering 15 bubbles would bury the first real question.
      if (answer.source === 'vault') {
        prefillCount += 1;
        paint();
        return;
      }
      messages.push({
        role: 'user',
        text: answer.value,
        light: answer.confidenceLight,
        fieldLabel: field?.label,
      });
      paint();
    },
    onDone: () => {
      void saveSession(session, true);
    },
    onError: (msg) => toast(msg, { tone: 'error' }),
    onClarify: (_fieldId, message) => {
      messages.push({ role: 'bot', text: message });
      paint();
      if (state.settings.voiceOutput) speak(message);
    },
  });

  /* ── painting ───────────────────────────────────────────────────────── */

  function paint(): void {
    const counts = countsFor(session);
    const pct = Math.round(completion(session) * 100);
    const lastLog = getLastRouteLog(session.id, 'interview_turn');

    screen.replaceChildren(
      header(counts, pct),
      chatColumn(),
      currentTurn?.done ? doneBar() : composer(),
      lastLog
        ? (() => {
            const d = h('div', { style: 'opacity:.85;margin-top:8px' });
            d.innerHTML = provenanceLine(lastLog);
            return d;
          })()
        : '',
    );
    if (!freeze) scrollToBottom();
  }

  function header(counts: { green: number; yellow: number; red: number }, pct: number): HTMLElement {
    const wrap = h('div', { style: 'position:sticky;top:0;z-index:25;background:var(--paper);padding-bottom:8px;margin:-2px 0 4px' });
    const bar = h('div', { class: 'row between gap-8' });
    bar.innerHTML = `
      <div class="row gap-8" style="min-width:0">
        <span class="avatar" aria-hidden="true">F</span>
        <div style="min-width:0">
          <div class="strong text-sm truncate">${escape(session.title)}</div>
          <div class="text-2xs muted">${pct}% filled · ${counts.red} empty</div>
        </div>
      </div>
    `;
    const right = h('div', { class: 'row gap-6' });
    right.innerHTML = lightCounts(counts);
    const listBtn = h('button', { class: 'icon-btn sm', 'aria-label': 'Open field list', title: 'Field list' }, '☰');
    listBtn.addEventListener('click', () => go('checklist', session.id));
    right.append(listBtn);
    bar.append(right);

    const progress = h('div', { class: 'progress mt-8' }, h('i', { style: `width:${pct}%` }));
    const chips = h('div', { class: 'row wrap gap-4 mt-8' });
    chips.innerHTML = `${badgeForLog(getLastRouteLog(session.id, 'interview_turn'))}${
      state.settings.demoMode ? badge({ kind: 'demo', small: true }) : ''
    }${state.settings.simulatedOffline ? badge({ kind: 'offline', small: true }) : ''}`;

    wrap.append(bar, progress, chips);
    return wrap;
  }

  function chatColumn(): HTMLElement {
    const col = h('div', { class: 'chat', id: 'chat-column' });

    if (prefillCount > 0) {
      const card = h('div', { class: 'card card-tight', style: 'border-color:var(--green-500);background:var(--green-100)' });
      card.innerHTML = `
        <div class="row gap-8">
          <span class="avatar" aria-hidden="true">🔐</span>
          <div style="flex:1">
            <b class="text-sm" style="color:var(--green-800)">${prefillCount} fields filled from Answer Vault</b>
            <div class="text-2xs" style="color:var(--green-800);opacity:.85">Typed once - works on every form now.</div>
          </div>
        </div>`;
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => go('checklist', session.id));
      col.append(card);
    }
    for (const m of messages) {
      if (m.role === 'bot') {
        const bubble = h('div', { class: 'bubble bubble-bot' });
        bubble.innerHTML = `${escape(m.text)}${
          m.turn?.hint ? `<div class="bubble-hint mt-8">💡 ${escape(m.turn.hint)}</div>` : ''
        }`;
        col.append(bubble);
      } else {
        const bubble = h('div', { class: 'bubble bubble-user' });
        bubble.innerHTML = `${escape(m.text)}${
          m.fieldLabel ? `<div class="text-2xs mt-8" style="opacity:.75">${escape(m.fieldLabel)}</div>` : ''
        }`;
        col.append(bubble);
        if (m.light) {
          const meta = h('div', { class: 'row gap-6', style: 'align-self:flex-end;padding-right:4px' });
          meta.innerHTML = `${light(m.light, { withLabel: true, size: 'sm' })}${badge({ kind: 'offline', small: true, label: 'Saved locally' })}`;
          col.append(meta);
        }
      }
    }
    if (engine.isBusy) {
      const typing = h('div', { class: 'bubble bubble-bot typing' });
      typing.innerHTML = '<i></i><i></i><i></i>';
      col.append(typing);
    }
    return col;
  }

  function composer(): HTMLElement {
    const wrap = h('div', { class: 'composer' });
    const expects = currentTurn?.expects ?? 'free_text';

    // Choice fields get chips instead of a keyboard - one tap per answer.
    if (expects === 'choice' && currentTurn?.options?.length) {
      const chipWrap = h('div', { class: 'row wrap gap-8 flex1' });
      for (const opt of currentTurn.options) {
        const chip = h('button', { class: 'chip' }, opt);
        chip.addEventListener('click', () => {
          void answer(opt, 'typed');
        });
        chipWrap.append(chip);
      }
      const skip = h('button', { class: 'btn btn-ghost btn-sm' }, 'Skip');
      skip.addEventListener('click', () => void engine.skip().then(() => syncOrder()));
      wrap.append(chipWrap, skip);
      return wrap;
    }

    const ta = h('textarea', {
      rows: '1',
      placeholder: expects === 'number' ? 'Numbers only…' : 'Type here…',
      'aria-label': 'Your answer',
      inputmode: expects === 'number' ? 'numeric' : 'text',
      autocomplete: 'off',
    }) as HTMLTextAreaElement;

    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !isMobileKeyboard(ev)) {
        ev.preventDefault();
        void submit();
      }
    });

    const submit = async () => {
      const v = ta.value.trim();
      if (!v) return;
      ta.value = '';
      ta.style.height = 'auto';
      await answer(v, 'typed');
    };

    const send = h('button', { class: 'send', 'aria-label': 'Send answer', disabled: 'true' }, '➤');
    ta.addEventListener('input', () => {
      send.toggleAttribute('disabled', ta.value.trim().length === 0);
    });
    send.addEventListener('click', () => void submit());

    wrap.append(ta);

    if (state.settings.voiceInput && voiceInputSupported()) {
      const mic = h('button', { class: 'mic-btn', 'aria-label': 'Answer by voice', title: 'Answer by voice' }, '🎤');
      mic.addEventListener('click', () => {
        if (listening) {
          listening.stop();
          listening = null;
          mic.classList.remove('listening');
          return;
        }
        mic.classList.add('listening');
        listening = startListening({
          lang: 'en-IN',
          onInterim: (text) => {
            ta.value = text;
            send.removeAttribute('disabled');
          },
          onFinal: (text) => {
            mic.classList.remove('listening');
            listening = null;
            ta.value = text;
            void submit();
          },
          onError: (msg) => {
            mic.classList.remove('listening');
            listening = null;
            if (msg) toast(msg, { tone: 'warn' });
          },
        });
      });
      wrap.append(mic);
    }

    wrap.append(send);

    const tools = h('div', { class: 'row wrap gap-8 mt-8' });
    const skipBtn = h('button', { class: 'btn btn-ghost btn-sm' }, 'Skip');
    skipBtn.addEventListener('click', () => void engine.skip().then(() => syncOrder()));
    const backBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '← Back');
    backBtn.addEventListener('click', () => void engine.back().then(() => syncOrder()));
    const vaultBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '🔐 From vault');
    vaultBtn.addEventListener('click', () => void fillFromVault());
    tools.append(backBtn, skipBtn, vaultBtn);

    const shellWrap = h('div', {}, wrap, tools);
    return shellWrap;
  }

  function doneBar(): HTMLElement {
    const bar = h('div', { class: 'card mt-16' });
    bar.innerHTML = `
      <div class="card-title">Interview complete</div>
      <p class="text-sm muted mt-2">Now see the checklist, then run cloud verify.</p>
    `;
    const row = h('div', { class: 'row gap-8 mt-12' });
    const next = h('button', { class: 'btn btn-primary flex1' }, 'Open checklist →');
    next.addEventListener('click', () => go('checklist', session.id));
    row.append(next);
    bar.append(row);
    return bar;
  }

  /* ── behaviour ──────────────────────────────────────────────────────── */

  async function answer(value: string, source: Answer['source']): Promise<void> {
    if (engine.isBusy) return;
    await engine.submitAnswer(value, source);
  }

  function syncOrder(): void {
    /* engine drives its own cursor; painting refreshes header/progress */
    paint();
  }

  async function fillFromVault(): Promise<void> {
    if (!state.vaultUnlocked) {
      toast('Vault is locked - unlock it first', { tone: 'warn' });
      go('vault');
      return;
    }
    toast('Vault answers can be applied from the checklist', { tone: 'info' });
    go('checklist', session.id);
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
  }

  function openDoneSheet(): void {
    freeze = true;
    const counts = countsFor(session);
    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <div class="row gap-8 wrap">${light('green', { withLabel: true })}<b>${counts.green}</b>
      ${light('yellow', { withLabel: true })}<b>${counts.yellow}</b>
      ${light('red', { withLabel: true })}<b>${counts.red}</b></div>
      <p class="text-sm muted">${
        counts.red > 0
          ? `${counts.red} compulsory field(s) are empty. You can fill them from the checklist.`
          : 'All compulsory fields are filled. Now run cloud verify - it will match against the official instructions.'
      }</p>
      <div class="card-flat">
        <b class="text-sm">Where did your data go?</b>
        <p class="text-xs muted mt-2">All interview questions ran on-device. Answers are saved in your phone's encrypted vault. The cloud sees only the format, never the values.</p>
      </div>
    `;
    const footer = h('div', { class: 'row gap-8' });
    const check = h('button', { class: 'btn btn-primary flex1' }, 'Checklist');
    check.addEventListener('click', () => {
      sheet.close();
      go('checklist', session.id);
    });
    const keep = h('button', { class: 'btn btn-ghost btn-sm' }, 'Stay here');
    keep.addEventListener('click', () => {
      freeze = false;
      sheet.close();
    });
    footer.append(check, keep);
    const sheet = openSheet({ title: 'Done!', body, footer, onClose: () => (freeze = false) });
  }

  function emptyState(msg = 'Add a form first, then the interview will start.'): HTMLElement {
    return h(
      'div',
      {},
      screenHeader({ title: 'Interview', back: () => go('home') }),
      h('div', { class: 'card empty' }, h('span', { class: 'ic' }, '📄'), h('div', { class: 'text-sm' }, msg)),
      h('button', { class: 'btn btn-primary btn-block mt-16', onclick: () => go('intake', 'photo') }, 'Add a form'),
    );
  }

  /* ── start ──────────────────────────────────────────────────────────── */

  paint();
  const { prefilled, remaining } = await engine.start();
  if (prefilled > 0) {
    toast(
      `🔐 ${prefilled} field(s) auto-filled from Answer Vault - ${remaining} left.`,
      { tone: 'success', ms: 4200 },
    );
  }
  if (routerState.capability && routerState.capability.support !== 'available' && !state.settings.demoMode) {
    toast(routerState.capability.reason, { tone: 'info', ms: 5000 });
  }

  const unsub = subscribe(() => {
    if (!document.body.contains(screen)) return;
    // Settings toggles (voice off/on) should affect the next question.
  });

  return () => {
    unsub();
    stopSpeaking();
    if (listening) {
      listening.stop();
      listening = null;
    }
    void saveSession(session, true);
  };
}

function isMobileKeyboard(ev: KeyboardEvent): boolean {
  // On soft keyboards Enter is the "go" key; we still want it to submit, so this
  // returns false except when the user is composing (IME, Devanagari input).
  return ev.isComposing;
}

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
}

export { computeLight, loadImageBlob };
