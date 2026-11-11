/**
 * The interview engine - MVP feature 2.
 *
 * This is a state machine, NOT a chat session. Each turn builds a fresh
 * `InterviewState`, calls the router (single-turn, on-device), and folds the
 * result back into the session. Consequences that matter:
 *
 *  • Airplane mode works: no server-side conversation state to lose.
 *  • Tab eviction works: resume is a fresh call with the same packed state.
 *  • The model never sees a transcript, so an Aadhaar number is never sitting
 *    in a growing context window.
 *  • Fields already answered from the vault are skipped BEFORE the first turn,
 *    which is what makes the second form feel 80% pre-filled.
 *
 * Free-form questions go through `askFreeform`, which the router sends to the
 * cloud because on-device inference has no multi-turn support.
 */

import type { Answer, FormSession, InterviewState, InterviewTurn } from '../lib/types';
import { routeInterviewTurn, routeFreeformChat, routeNormalizeAnswer, setSessionContext } from '../ai/router';
import { canonicalKeyFor, isSensitiveField, putAnswer, prefillFor, bumpUses } from '../vault/vault';
import { computeLight, saveSession } from './sessions';
import { normalizeLabel } from '../lib/util';

export interface InterviewCallbacks {
  onTurn: (turn: InterviewTurn, session: FormSession) => void;
  onAnswer: (fieldId: string, answer: Answer, session: FormSession) => void;
  onDone: (session: FormSession) => void;
  onError: (message: string) => void;
  /**
   * The answer did not fit the field (e.g. a date typed into Aadhaar).
   * Fired INSTEAD of storing the value - the interview stays on the same field.
   * Storing a value we do not believe is exactly how a form gets rejected, so
   * the engine would rather ask again.
   */
  onClarify?: (fieldId: string, message: string) => void;
}

/** Below this normalized confidence we ask again rather than save. */
const CLARIFY_THRESHOLD = 0.6;

export class InterviewEngine {
  private session: FormSession;
  private cb: InterviewCallbacks;
  private order: string[] = [];
  private cursor = 0;
  private busy = false;
  private currentTurn: InterviewTurn | null = null;

  constructor(session: FormSession, cb: InterviewCallbacks) {
    this.session = session;
    this.cb = cb;
    setSessionContext(session.id);
  }

  getSession(): FormSession {
    return this.session;
  }

  /** Which field the interview is on (for the UI's sticky card). */
  get currentFieldId(): string | null {
    return this.currentTurn?.fieldId ?? this.order[this.cursor] ?? null;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get current(): InterviewTurn | null {
    return this.currentTurn;
  }

  /**
   * Pre-fill from the vault, then start asking whatever is left.
   * Returns how many fields the vault answered - the number the demo brags
   * about ("second form, 14 fields, zero typing").
   */
  async start(): Promise<{ prefilled: number; remaining: number }> {
    const fields = this.session.extraction?.fields ?? [];
    const map = await prefillFor(fields.map((f) => ({ id: f.id, label: f.label })));

    let prefilled = 0;
    const usedRecordIds: string[] = [];
    for (const [fieldId, record] of Object.entries(map)) {
      const field = fields.find((f) => f.id === fieldId);
      if (!field) continue;
      // Never overwrite something the user already typed in this session.
      if (this.session.answers[fieldId]?.value) continue;
      const answer: Answer = {
        fieldId,
        value: record.value,
        confidence: 0.93,
        confidenceLight: 'green',
        source: 'vault',
        author: 'user',
        note: 'Answer Vault se mila',
        updatedAt: Date.now(),
      };
      this.session.answers[fieldId] = answer;
      prefilled += 1;
      usedRecordIds.push(record.id);
      this.cb.onAnswer(fieldId, answer, this.session);
    }
    if (usedRecordIds.length) await bumpUses(usedRecordIds);
    await saveSession(this.session, true);

    // Order: form order, unanswered only.
    this.order = fields.filter((f) => !this.session.answers[f.id]?.value?.trim()).map((f) => f.id);
    this.cursor = 0;

    if (this.order.length === 0) {
      const turn: InterviewTurn = {
        question: 'All fields are already filled - the Answer Vault at work. Let us check now.',
        fieldId: null,
        done: true,
        expects: 'free_text',
      };
      this.currentTurn = turn;
      this.cb.onTurn(turn, this.session);
      this.cb.onDone(this.session);
      return { prefilled, remaining: 0 };
    }

    await this.askNext();
    return { prefilled, remaining: this.order.length };
  }

  /** Build the packed state for the current cursor position. */
  private buildState(): InterviewState {
    const fields = this.session.extraction?.fields ?? [];
    const known: Record<string, string> = {};
    for (const [id, a] of Object.entries(this.session.answers)) {
      if (a.value?.trim()) known[id] = a.value;
    }
    const remaining = fields
      .filter((f) => !known[f.id])
      .map((f) => ({ id: f.id, label: f.label, type: f.type, hint: f.hint }));

    return {
      formTitle: this.session.title,
      formType: this.session.formType,
      remaining,
      known,
      currentFieldId: this.order[this.cursor] ?? remaining[0]?.id ?? '',
      language: 'en',
    };
  }

  /** Ask the next question (one single-turn model call). */
  private async askNext(lastUserInput?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = this.buildState();
      if (state.remaining.length === 0) {
        const turn: InterviewTurn = {
          question: 'Bas, saare fields bhar gaye. Ab form check karta hoon.',
          fieldId: null,
          done: true,
          expects: 'free_text',
        };
        this.currentTurn = turn;
        this.cb.onTurn(turn, this.session);
        this.cb.onDone(this.session);
        return;
      }
      const { turn } = await routeInterviewTurn({ state, userInput: lastUserInput });

      // Keep our own cursor authoritative: the model may name a field it saw in
      // `remaining`, but if it names something out of order we still follow the
      // form's printed order (users expect top-to-bottom).
      const target = this.order[this.cursor];
      const effective: InterviewTurn =
        turn.fieldId && this.order.includes(turn.fieldId)
          ? turn
          : { ...turn, fieldId: target ?? turn.fieldId };

      this.currentTurn = effective;
      this.cb.onTurn(effective, this.session);
      if (effective.done) this.cb.onDone(this.session);
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : 'Interview turn fail ho gaya.');
    } finally {
      this.busy = false;
    }
  }

  /**
   * Submit the user's answer for the field currently being asked.
   * Normalization (the "pachas hazaar" → 50000 step) is a separate on-device
   * call routed through `answer_repair`.
   */
  async submitAnswer(raw: string, source: Answer['source'] = 'typed'): Promise<void> {
    const fieldId = this.currentTurn?.fieldId ?? this.order[this.cursor];
    if (!fieldId) return;
    const fields = this.session.extraction?.fields ?? [];
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;

    const trimmed = raw.trim();
    if (!trimmed) {
      // Empty = skip. Required fields stay red and the UI says so.
      this.cursor = Math.min(this.cursor + 1, this.order.length);
      await this.askNext();
      return;
    }

    let normalized = { value: trimmed, confidence: 0.8, note: '' };
    try {
      const out = await routeNormalizeAnswer({
        field: { id: field.id, label: field.label, type: field.type, hint: field.hint },
        raw: trimmed,
      });
      normalized = { value: out.value, confidence: out.confidence, note: out.note };
    } catch {
      // If normalization fails we still accept the raw answer - losing the
      // user's input is worse than an unformatted value.
    }

    // Ask again when the value's shape clearly does not fit the field. The user
    // keeps the field, the model keeps its credibility.
    if (normalized.confidence < CLARIFY_THRESHOLD && trimmed.length > 0) {
      const why =
        normalized.note ||
        `"${trimmed}" does not fit the field's format. Please tell us once more?`;
      this.cb.onClarify?.(fieldId, why);
      return;
    }

    const answer: Answer = {
      fieldId,
      value: normalized.value,
      confidence: normalized.confidence,
      confidenceLight: 'yellow',
      source,
      author: 'on-device',
      note: normalized.note || undefined,
      updatedAt: Date.now(),
    };
    answer.confidenceLight = computeLight(field, answer);

    this.session.answers[fieldId] = answer;
    this.cb.onAnswer(fieldId, answer, this.session);

    // Save to the vault (encrypted, local) so the NEXT form pre-fills.
    try {
      await putAnswer({
        id: canonicalKeyFor(field.label),
        label: field.label,
        value: normalized.value,
        sensitive: isSensitiveField(field.label),
      });
    } catch {
      // Vault locked or crypto unavailable: the answer still counts for this
      // form, it just will not be reusable. Surfaced in the vault screen.
    }

    await saveSession(this.session);
    this.cursor = Math.min(this.cursor + 1, this.order.length);
    await this.askNext(trimmed);
  }

  /** Skip without answering. */
  async skip(): Promise<void> {
    this.cursor = Math.min(this.cursor + 1, this.order.length);
    await this.askNext();
  }

  /** Go back one field, e.g. when the user wants to fix a typo. */
  async back(): Promise<void> {
    this.cursor = Math.max(0, this.cursor - 1);
    await this.askNext();
  }

  /** Jump straight to a field (tapping a red light on the checklist). */
  async jumpTo(fieldId: string): Promise<void> {
    const idx = this.order.indexOf(fieldId);
    if (idx >= 0) this.cursor = idx;
    else {
      // Already answered: treat as edit - re-insert into the order at the front.
      this.order.unshift(fieldId);
      this.cursor = 0;
    }
    await this.askNext();
  }

  /** Free-form question. Route: CLOUD (multi-turn unsupported on-device). */
  async askFreeform(
    question: string,
    history: Array<{ role: 'user' | 'model'; text: string }>,
  ): Promise<string> {
    const { answer } = await routeFreeformChat({ history, question });
    return answer;
  }

  /**
   * Manual edit from the checklist (not part of the linear interview).
   * Recomputes the light and persists; also updates the vault.
   */
  async setAnswerValue(fieldId: string, value: string): Promise<Answer | null> {
    const fields = this.session.extraction?.fields ?? [];
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return null;
    const answer: Answer = {
      ...(this.session.answers[fieldId] ?? {
        fieldId,
        source: 'typed' as const,
        author: 'user' as const,
        updatedAt: Date.now(),
      }),
      value,
      updatedAt: Date.now(),
      confidence: this.session.answers[fieldId]?.cloudVerified ? 0.95 : 0.85,
    };
    answer.confidenceLight = computeLight(field, answer, {
      cloudFlagged: false,
    });
    this.session.answers[fieldId] = answer;
    try {
      await putAnswer({
        id: canonicalKeyFor(field.label),
        label: field.label,
        value,
        sensitive: isSensitiveField(field.label),
      });
    } catch {
      /* vault locked */
    }
    await saveSession(this.session);
    this.cb.onAnswer(fieldId, answer, this.session);
    return answer;
  }

  /** Accept a cloud suggestion for one field. */
  async acceptSuggestion(fieldId: string, suggested: string): Promise<void> {
    const a = await this.setAnswerValue(fieldId, suggested);
    if (a) {
      a.author = 'cloud';
      a.cloudVerified = true;
      a.confidence = 0.96;
      a.confidenceLight = 'green';
      a.note = 'Cloud verify fixed it';
      await saveSession(this.session, true);
      this.cb.onAnswer(fieldId, a, this.session);
    }
  }
}

/** Which vault key a form's field maps to - exported for the UI's tooltips. */
export function vaultKeyFor(label: string): string {
  return canonicalKeyFor(label);
}

/** Debug helper used by the settings panel: how much of a form is reusable. */
export function vaultCoverage(
  fields: Array<{ label: string }>,
  records: Array<{ id: string }>,
): { matched: number; total: number } {
  const have = new Set(records.map((r) => r.id));
  let matched = 0;
  for (const f of fields) {
    if (have.has(canonicalKeyFor(f.label)) || have.has(normalizeLabel(f.label))) matched += 1;
  }
  return { matched, total: fields.length };
}
