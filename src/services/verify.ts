/**
 * Cloud verify pass - MVP feature 4, and the app's only truly networked step.
 *
 * Pipeline (in order, and this order is the privacy guarantee):
 *   1. buildCloudPayload()  → sensitive values replaced by shape descriptors
 *   2. scrubPrompt()        → second pass over the assembled prompt string
 *   3. routeCloudVerify()   → the only network call in this file
 *   4. sanitizeVerifyResult()→ drop any sneaky value the model echoed back
 *   5. applyVerdicts()      → lights, notes, badges; user accepts fixes
 *
 * Offline: the whole thing is enqueued (services/sync.ts) and replayed on the
 * 'online' event. That is the demo beat where the badge flips from
 * "on-device" to "cloud-verified" by itself.
 */

import type { Answer, CloudVerifyResult, FormSession } from '../lib/types';
import {
  buildCloudPayload,
  redactionReceipt,
  sanitizeVerifyResult,
  scrubPrompt,
  type CloudFieldPayload,
} from '../ai/redact';
import { buildCloudVerifyPrompt } from '../ai/prompts';
import { routeCloudVerify } from '../ai/router';
import { computeLight, saveSession } from './sessions';
import { enqueue, registerRunner } from './sync';
import { setSessionContext } from '../ai/router';

export interface VerifyOutcome {
  result: CloudVerifyResult;
  /** What the cloud actually received - shown in the Privacy receipt sheet. */
  receipt: string;
  redactedCount: number;
  queued: boolean;
}

/** Session-level in-memory cache so the receipt survives re-renders. */
const receipts = new Map<string, string>();

export function receiptFor(sessionId: string): string | null {
  return receipts.get(sessionId) ?? null;
}

export async function runCloudVerify(
  session: FormSession,
  opts: { demoProfile?: 'clean' | 'income-monthly' | 'wrong-ifsc' | 'plus91' } = {},
): Promise<VerifyOutcome> {
  const fields = session.extraction?.fields ?? [];
  setSessionContext(session.id);

  // 1. Redact.
  const { payload, report } = buildCloudPayload(fields, session.answers);

  // 2. Scrub the assembled prompt (belt and braces).
  const rawPrompt = buildCloudVerifyPrompt({
    formTitle: session.title,
    formType: session.formType,
    instructionText: session.instructionText ?? '',
    fields: payload,
  });
  const scrubbed = scrubPrompt(rawPrompt, session.answers, fields);
  const receipt = redactionReceipt(payload, report);
  receipts.set(session.id, receipt + (scrubbed.scrubbed ? `\n\n· Extra scrub: ${scrubbed.scrubbed} value(s) prompt se hataye gaye.` : ''));

  // 3. Call.
  try {
    session.verifyStatus = 'running';
    await saveSession(session);

    const { result } = await routeCloudVerify({
      formTitle: session.title,
      formType: session.formType,
      instructionText: session.instructionText ?? '',
      fields: payload satisfies CloudFieldPayload[],
      demoProfile: opts.demoProfile,
    });

    // 4. Sanitize: a redacted field must never come back with a value.
    const safe = sanitizeVerifyResult(result, session.answers, fields);

    // 5. Apply.
    session.verify = safe;
    session.verifyStatus = 'done';
    applyVerdictsToAnswers(session, safe);
    await saveSession(session, true);

    return {
      result: safe,
      receipt,
      redactedCount: report.redactedFieldIds.length,
      queued: false,
    };
  } catch (err) {
    const isOffline = err instanceof Error && /offline/i.test(err.message);
    if (isOffline) {
      session.verifyStatus = 'queued';
      await saveSession(session, true);
      await enqueue('cloud_verify', session.id);
      return {
        result: {
          verdicts: [],
          summary:
            'No internet - verify has been queued. It will run automatically when the network returns; you do not need to do anything.',
          overallConfidence: 0.5,
        },
        receipt,
        redactedCount: report.redactedFieldIds.length,
        queued: true,
      };
    }
    session.verifyStatus = 'error';
    await saveSession(session, true);
    throw err;
  }
}

/**
 * Fold verdicts into the answers: flags become yellow/red lights with a
 * English reason, and cloud-checked fields get the `cloudVerified` badge.
 * A fix is only ever SHOWN - never silently applied.
 */
export function applyVerdictsToAnswers(session: FormSession, result: CloudVerifyResult): void {
  const fields = session.extraction?.fields ?? [];
  const byField = new Map(result.verdicts.map((v) => [v.fieldId, v]));

  for (const field of fields) {
    const a: Answer | undefined = session.answers[field.id];
    const verdict = byField.get(field.id);

    if (!verdict) continue;

    if (!a) {
      // Verdict on an empty field - nothing to annotate beyond the light.
      if (verdict.status !== 'ok' && verdict.reason) {
        session.notes = Array.from(new Set([...(session.notes ?? []), `${field.label}: ${verdict.reason}`]));
      }
      continue;
    }

    const next: Answer = {
      ...a,
      cloudVerified: true,
      author: verdict.status === 'ok' ? 'cloud' : a.author,
      flagReason: verdict.status === 'ok' ? undefined : verdict.reason,
      suggestion: verdict.suggestedValue,
      updatedAt: Date.now(),
    };
    next.confidenceLight = computeLight(field, next, { cloudFlagged: verdict.status !== 'ok' });
    session.answers[field.id] = next;
  }
}

/** Wire the offline queue: when connectivity returns, verify runs itself. */
export function registerVerifyRunner(
  loadSession: (id: string) => Promise<FormSession | null>,
  onDone?: (sessionId: string, result: CloudVerifyResult) => void,
): void {
  registerRunner('cloud_verify', async (task) => {
    const session = await loadSession(task.sessionId);
    if (!session) return true; // session deleted - drop the task
    if (!session.extraction) return true;
    try {
      const out = await runCloudVerify(session);
      if (out.queued) return false;
      onDone?.(session.id, out.result);
      return true;
    } catch {
      return false;
    }
  });
}

/** Count of fields with a flag, for the sticky header chip. */
export function flagCount(session: FormSession): number {
  return (session.verify?.verdicts ?? []).filter((v) => v.status !== 'ok').length;
}
