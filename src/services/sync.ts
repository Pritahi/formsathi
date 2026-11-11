/**
 * Offline queue - MVP feature 6.
 *
 * Steps 1–3 and 5 work with the radio off. Step 4 (cloud verify) is the only
 * thing that truly needs a network, so it is queued here and replayed when
 * connectivity returns. Two triggers:
 *   • 'online' event
 *   • a 20 s poll while the queue is non-empty (covers captive portals and
 *     browsers that never fire 'online')
 *
 * The queue holds only session IDs - never payloads - because the session and
 * the vault are already durable in IndexedDB. That keeps the queue tiny and
 * makes it survive a reload for free.
 */

import { kv } from '../lib/idb';

export type PendingKind = 'cloud_verify' | 'session_sync' | 'image_upload';

export interface PendingTask {
  id: string;
  kind: PendingKind;
  sessionId: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

const QUEUE_KEY = 'sync_queue';
const POLL_MS = 20_000;

type Runner = (task: PendingTask) => Promise<boolean>;

const runners = new Map<PendingKind, Runner>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

export function registerRunner(kind: PendingKind, fn: Runner): void {
  runners.set(kind, fn);
}

export async function getQueue(): Promise<PendingTask[]> {
  return (await kv.get<PendingTask[]>(QUEUE_KEY)) ?? [];
}

async function saveQueue(q: PendingTask[]): Promise<void> {
  await kv.set(QUEUE_KEY, q);
}

export async function enqueue(kind: PendingKind, sessionId: string): Promise<PendingTask> {
  const q = await getQueue();
  // Only one pending task per (kind, session) - re-running verify twice is
  // pointless and would double-charge the free-tier quota.
  const existing = q.find((t) => t.kind === kind && t.sessionId === sessionId);
  if (existing) return existing;
  const task: PendingTask = {
    id: `${kind}:${sessionId}`,
    kind,
    sessionId,
    createdAt: Date.now(),
    attempts: 0,
  };
  q.push(task);
  await saveQueue(q);
  ensurePolling();
  return task;
}

export async function dequeue(taskId: string): Promise<void> {
  const q = await getQueue();
  await saveQueue(q.filter((t) => t.id !== taskId));
}

export async function markFailed(taskId: string, error: string): Promise<void> {
  const q = await getQueue();
  const t = q.find((x) => x.id === taskId);
  if (t) {
    t.attempts += 1;
    t.lastError = error;
    // Give up after 5 attempts so a permanently broken task cannot spin.
    if (t.attempts >= 5) {
      await saveQueue(q.filter((x) => x.id !== taskId));
      return;
    }
    await saveQueue(q);
  }
}

/** Try to run everything in the queue. Safe to call often. */
export async function flushQueue(): Promise<{ ran: number; ok: number }> {
  if (flushing) return { ran: 0, ok: 0 };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ran: 0, ok: 0 };
  flushing = true;
  let ran = 0;
  let ok = 0;
  try {
    const q = await getQueue();
    for (const task of q) {
      const runner = runners.get(task.kind);
      if (!runner) continue;
      ran += 1;
      try {
        const success = await runner(task);
        if (success) {
          await dequeue(task.id);
          ok += 1;
        } else {
          await markFailed(task.id, 'runner returned false');
        }
      } catch (err) {
        await markFailed(task.id, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    flushing = false;
  }
  if ((await getQueue()).length === 0) stopPolling();
  return { ran, ok };
}

function ensurePolling(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushQueue();
  }, POLL_MS);
}

export function stopPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Wire the browser events once at boot. */
export function startSyncLoop(onChange?: (q: PendingTask[]) => void): () => void {
  const onOnline = () => {
    void flushQueue().then(async () => onChange?.(await getQueue()));
  };
  window.addEventListener('online', onOnline);
  ensurePolling();
  void flushQueue().then(async () => onChange?.(await getQueue()));

  return () => {
    window.removeEventListener('online', onOnline);
    stopPolling();
  };
}

export async function pendingCount(): Promise<number> {
  return (await getQueue()).length;
}
