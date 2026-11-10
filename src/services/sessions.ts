/**
 * Session store — durable, offline-first persistence for everything except
 * answer values (those live in the vault).
 *
 * Two stores are used:
 *   sessions : FormSession JSON (labels, lights, statuses, no raw values that
 *              the vault considers sensitive — but non-sensitive values do live
 *              here so the answer sheet survives a reload while the vault is
 *              locked; see the note in README → Privacy model).
 *   images   : the compressed form photo blob, keyed by session id.
 *
 * All writes are debounced per session so a fast typist does not hammer IDB.
 */

import { idb, kv, STORE } from '../lib/idb';
import type { Answer, Confidence, FormSession } from '../lib/types';
import { uid } from '../lib/util';

export function newSession(partial: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: uid('form'),
    createdAt: now,
    updatedAt: now,
    title: 'Untitled form',
    formType: 'other',
    extraction: null,
    instructionText: null,
    sourceImageKey: null,
    sourceImageMime: null,
    isPdf: false,
    answers: {},
    verify: null,
    verifyStatus: 'idle',
    extractStatus: 'idle',
    notes: [],
    ...partial,
  };
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function saveSession(session: FormSession, immediate = false): Promise<void> {
  const write = async () => {
    session.updatedAt = Date.now();
    await idb.put(STORE.sessions, session);
    writeTimers.delete(session.id);
  };
  if (immediate) {
    await write();
    return;
  }
  const existing = writeTimers.get(session.id);
  if (existing) clearTimeout(existing);
  writeTimers.set(
    session.id,
    setTimeout(() => void write(), 250),
  );
}

export async function loadSession(id: string): Promise<FormSession | null> {
  return (await idb.get<FormSession>(STORE.sessions, id)) ?? null;
}

export async function listSessions(): Promise<FormSession[]> {
  const all = await idb.all<FormSession>(STORE.sessions);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<void> {
  await idb.del(STORE.sessions, id);
  await idb.del(STORE.images, id);
}

export async function saveImage(sessionId: string, blob: Blob): Promise<void> {
  await idb.put(STORE.images, blob, sessionId);
}

export async function loadImageBlob(sessionId: string): Promise<Blob | null> {
  return (await idb.get<Blob>(STORE.images, sessionId)) ?? null;
}

/** Last opened session id, for "resume where you left off". */
const LAST_KEY = 'last_session';

export async function setLastSession(id: string | null): Promise<void> {
  if (id) await kv.set(LAST_KEY, id);
  else await kv.del(LAST_KEY);
}

export async function getLastSession(): Promise<string | null> {
  return (await kv.get<string>(LAST_KEY)) ?? null;
}

/* ── Answer bookkeeping & the traffic light ───────────────────────────── */

/**
 * The traffic light, in one place so it can never drift between screens.
 *
 *   red    — required and empty, or a value we could not parse at all
 *   yellow — present but needs a look: low model confidence, a cloud flag, a
 *            format that contradicts the form's own hint
 *   green  — present and either vault-sourced, cloud-verified, or high
 *            confidence
 *
 * Deliberately conservative: a field only turns green when we have a reason.
 * Over-promising green is how a form gets rejected.
 */
export function computeLight(
  _field: { id: string; required: boolean; type: string },
  answer: Answer | undefined,
  ctx?: { cloudFlagged?: boolean },
): Confidence {
  if (!answer || !answer.value || !answer.value.trim()) {
    // Missing is missing, required or not — the brief's red light means
    // "khali", and the UI separately labels optional empties as chhod sakte hain.
    return 'red';
  }
  if (ctx?.cloudFlagged) return 'yellow';
  if (answer.author === 'cloud' && answer.cloudVerified) return 'green';
  if (answer.source === 'vault' && answer.confidence >= 0.8) return 'green';
  if (answer.confidence >= 0.85) return 'green';
  if (answer.confidence >= 0.55) return 'yellow';
  return 'yellow';
}

export function lightCounts(session: FormSession): { green: number; yellow: number; red: number } {
  const counts = { green: 0, yellow: 0, red: 0 };
  const fields = session.extraction?.fields ?? [];
  const flagged = new Set((session.verify?.verdicts ?? []).filter((v) => v.status !== 'ok').map((v) => v.fieldId));
  for (const f of fields) {
    const light = computeLight(f, session.answers[f.id], { cloudFlagged: flagged.has(f.id) });
    counts[light] += 1;
  }
  return counts;
}

/** Fields still needing the interview, in form order. */
export function unansweredFields(session: FormSession): string[] {
  const fields = session.extraction?.fields ?? [];
  return fields
    .filter((f) => {
      const a = session.answers[f.id];
      return !a || !a.value?.trim();
    })
    .map((f) => f.id);
}

/** How much of the form is done, 0..1 — used by the progress ring. */
export function completion(session: FormSession): number {
  const fields = session.extraction?.fields ?? [];
  if (fields.length === 0) return 0;
  const filled = fields.filter((f) => session.answers[f.id]?.value?.trim()).length;
  return filled / fields.length;
}
