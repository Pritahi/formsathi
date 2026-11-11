/**
 * Domain types shared by every layer. Keeping the AI contract in one file is
 * what lets the demo mocks and the real Firebase AI Logic path be swapped
 * without touching the UI.
 */

/** ── Field extraction ─────────────────────────────────────────────────── */

export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'phone'
  | 'email'
  | 'select'
  | 'checkbox'
  | 'signature';

export interface ExtractedField {
  /** Stable slug, e.g. "annual_family_income". Used as the vault key. */
  id: string;
  /** Exactly as printed on the form (English or bilingual). */
  label: string;
  /** Hindi rendering of the label, for bilingual display. Optional. */
  labelHi?: string;
  type: FieldType;
  required: boolean;
  /** Any printed instruction next to the field, e.g. "(in figures only)". */
  hint?: string;
  /** Allowed values for select fields. */
  options?: string[];
  /** 0..1 - how sure the extractor is that this is a real fillable field. */
  confidence: number;
  /** Where the field sits on the source image, normalized 0..1 (for the
   * annotated overlay). Null when extraction came from text-only input. */
  box?: { x: number; y: number; w: number; h: number } | null;
  /** Page index (0-based) the field was found on. */
  page?: number;
}

export interface FormExtraction {
  /** What the form calls itself, as read off the paper. */
  title: string;
  /** e.g. "scholarship", "government_scheme", "exam", "job", "other". */
  formType: string;
  /** Issuing body if printed (e.g. "Ministry of Social Justice"). */
  authority?: string;
  fields: ExtractedField[];
  /** Free-form warnings from the extractor (blur, cut-off edge, handwriting). */
  notes?: string[];
}

/** ── Answers ─────────────────────────────────────────────────────────── */

export type Confidence = 'green' | 'yellow' | 'red';

/** Where an answer came from. Drives the vault autofill story. */
export type AnswerSource = 'vault' | 'voice' | 'typed' | 'sample';

/** Who produced the value: the user, the on-device model, or cloud verify. */
export type AnswerAuthor = 'user' | 'on-device' | 'cloud';

export interface Answer {
  fieldId: string;
  value: string;
  /** 0..1 model/user confidence that this value is right for the field. */
  confidence: number;
  confidenceLight: Confidence;
  source: AnswerSource;
  author: AnswerAuthor;
  /** One-liner shown under the field ("Income in figures only…"). */
  note?: string;
  /** Set when cloud verify ran on this field. */
  cloudVerified?: boolean;
  /** Cloud verify's correction suggestion, if any. */
  suggestion?: string;
  /** Cloud verify's reason for a yellow/red flag. */
  flagReason?: string;
  updatedAt: number;
}

/** ── Cloud verify ────────────────────────────────────────────────────── */

export interface FieldVerdict {
  fieldId: string;
  /** ok = no issue; warn = looks wrong but allowed; fix = must change. */
  status: 'ok' | 'warn' | 'fix';
  /** Explanation of the problem, shown in the field card. */
  reason?: string;
  /** Suggested corrected value (only for fields where the value is not
   * sensitive; sensitive fields get format advice instead of a rewrite). */
  suggestedValue?: string;
  /** Which rule/instruction line triggered this. */
  rule?: string;
}

export interface CloudVerifyResult {
  verdicts: FieldVerdict[];
  /** Summary of the whole form's state. */
  summary: string;
  /** 0..1 */
  overallConfidence: number;
  /** Instruction lines the model actually used. */
  instructionsUsed?: string[];
}

/** ── Interview ───────────────────────────────────────────────────────── */

/**
 * The interview is a sequence of SINGLE-TURN prompts. Instead of a chat
 * history we pack this state object into every prompt. This is the single
 * most important design constraint in the product (see README).
 */
export interface InterviewState {
  formTitle: string;
  formType: string;
  /** Ordered field list, ids + labels only - keeps the prompt small. */
  remaining: Array<{ id: string; label: string; type: FieldType; hint?: string }>;
  /** Already-collected answers, keyed by field id. Packed every turn. */
  known: Record<string, string>;
  /** The field being asked about right now. */
  currentFieldId: string;
  /** Last thing the user said, if any. */
  lastUserInput?: string;
  language: 'en' | 'hinglish';
}

export interface InterviewTurn {
  /** The next question to speak/show. */
  question: string;
  /** Which field this question is for (may differ from currentFieldId if the
   * model decides to ask something else first). */
  fieldId: string | null;
  /** True when the model believes the interview is complete. */
  done: boolean;
  /** Optional gentle nudge, e.g. "If you don't know, skip it". */
  hint?: string;
  /** How the model wants the answer parsed. */
  expects: 'free_text' | 'number' | 'date' | 'choice';
  options?: string[];
}

/** ── Form session (persisted) ────────────────────────────────────────── */

export type StepStatus = 'idle' | 'running' | 'done' | 'error' | 'queued';

export interface FormSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  formType: string;
  authority?: string;
  /** Extraction result (no personal data - labels only). */
  extraction: FormExtraction | null;
  /** OCR text of the instruction page, if the user photographed it. */
  instructionText: string | null;
  /** Lightweight pointer to the source image; the blob itself lives in a
   * separate IndexedDB store so sessions stay small. */
  sourceImageKey: string | null;
  sourceImageMime: string | null;
  /** True when the source is a PDF (rendered page 1 is the sourceImageKey). */
  isPdf: boolean;
  answers: Record<string, Answer>;
  /** Latest verify result, cached so the badges survive a reload. */
  verify: CloudVerifyResult | null;
  verifyStatus: StepStatus;
  /** Extraction status, for the resume / offline story. */
  extractStatus: StepStatus;
  notes: string[];
}

/** ── Router log ──────────────────────────────────────────────────────── */

export type InferencePath = 'local' | 'on-device' | 'cloud' | 'mock-on-device' | 'mock-cloud';

export type RouteTask =
  | 'field_extraction'
  | 'interview_turn'
  | 'answer_repair'
  | 'cloud_verify'
  | 'review_summary'
  | 'freeform_chat';

export interface RouteLogEntry {
  id: string;
  at: number;
  sessionId: string | null;
  task: RouteTask;
  /** What the router decided before any fallback happened. */
  requestedPath: 'on-device' | 'cloud';
  /** What actually produced the answer (after fallback). */
  actualPath: InferencePath;
  model: string;
  latencyMs: number;
  /** Bytes of image payload sent, if any. Sensitive-identity fields never
   * contribute bytes here because they are stripped before the call. */
  imageBytes?: number;
  /** True when sensitive values were redacted from this call's payload. */
  redacted: boolean;
  /** True when the call ran with no network (mock or real on-device). */
  offline: boolean;
  ok: boolean;
  error?: string;
  /** Short human reason shown in the demo's router log drawer. */
  reason: string;
  /** Prompt size in characters - evidence for the "packed state" claim. */
  promptChars: number;
}

