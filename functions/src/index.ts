/**
 * ============================================================================
 *  OPTIONAL: server-side cloud verify via a callable Cloud Function
 * ============================================================================
 *
 *  ** THIS IS NOT USED BY THE SUBMITTED APP, AND THAT IS DELIBERATE. **
 *
 *  Why the default path is client-side (src/ai/router.ts → routeCloudVerify):
 *    • Firebase AI Logic calls Gemini through your Firebase project, so there
 *      is no API key in the bundle and no billing account required. It runs on
 *      the Spark (free) plan.
 *    • Deploying Cloud Functions requires the Blaze (pay-as-you-go) plan. The
 *      brief's hard constraint is "Firebase Spark free tier only, no paid APIs",
 *      so shipping a Blaze-dependent default would break the constraint.
 *
 *  This file exists because the architecture note calls for a callable that
 *  "receives only the field schema + instruction text, never the Answer Vault".
 *  It is that contract, implemented and hardened — for anyone who later wants
 *  the verify step (and its Gemini key) off the device entirely. Enabling it is
 *  a two-step change, documented in README → "Optional: server-side verify".
 *
 *  Deploy:  firebase deploy --only functions   (requires Blaze)
 *  Secret:  firebase functions:secrets:set GEMINI_API_KEY
 *  Enable:  set FEATURES.cloudVerify = 'function' in src/config/config.ts
 * ============================================================================
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/* ── The payload contract ─────────────────────────────────────────────── */

interface VerifyField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  hint?: string;
  /** Already redacted by the client. May be a "12-digit number [format: ...]". */
  valueForCloud: string;
  valueRedacted: boolean;
}

interface VerifyRequest {
  formTitle: string;
  formType: string;
  instructionText: string;
  fields: VerifyField[];
}

/**
 * Server-side belt-and-braces. Even though the client redacts, this refuses any
 * request that still carries a plausible raw identity number, so a buggy or
 * malicious client cannot use this function as a data-laundering proxy.
 */
const RAW_IDENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/[2-9]\d{3}\s?\d{4}\s?\d{4}/, 'aadhaar-like 12-digit number'],
  [/[6-9]\d{9}/, 'mobile-like 10-digit number'],
  [/[A-Z]{5}\d{4}[A-Z]/, 'PAN-like value'],
  [/[A-Z]{4}0[A-Z0-9]{6}/, 'IFSC-like value'],
];

function assertRedacted(fields: VerifyField[]): void {
  for (const f of fields) {
    if (!f.valueRedacted) continue;
    for (const [re, what] of RAW_IDENTITY_PATTERNS) {
      if (re.test(f.valueForCloud)) {
        throw new HttpsError(
          'invalid-argument',
          `Field "${f.id}" is marked redacted but contains a raw ${what}. Refusing to forward it.`,
        );
      }
    }
  }
}

function validate(data: unknown): VerifyRequest {
  const d = data as Partial<VerifyRequest> | null;
  if (!d || typeof d !== 'object') throw new HttpsError('invalid-argument', 'Missing payload.');
  if (typeof d.instructionText !== 'string') {
    throw new HttpsError('invalid-argument', 'instructionText must be a string.');
  }
  if (!Array.isArray(d.fields) || d.fields.length === 0) {
    throw new HttpsError('invalid-argument', 'fields must be a non-empty array.');
  }
  if (d.fields.length > 200) throw new HttpsError('invalid-argument', 'Too many fields.');
  if (d.instructionText.length > 20_000) {
    throw new HttpsError('invalid-argument', 'instructionText too long.');
  }

  const fields: VerifyField[] = d.fields.map((f) => {
    const x = f as Partial<VerifyField>;
    if (typeof x.id !== 'string' || typeof x.label !== 'string') {
      throw new HttpsError('invalid-argument', 'Every field needs an id and a label.');
    }
    return {
      id: x.id.slice(0, 120),
      label: x.label.slice(0, 200),
      type: String(x.type ?? 'text').slice(0, 20),
      required: Boolean(x.required),
      hint: x.hint ? String(x.hint).slice(0, 200) : undefined,
      valueForCloud: String(x.valueForCloud ?? '').slice(0, 300),
      valueRedacted: Boolean(x.valueRedacted),
    };
  });

  assertRedacted(fields);

  return {
    formTitle: String(d.formTitle ?? 'Untitled').slice(0, 200),
    formType: String(d.formType ?? 'other').slice(0, 40),
    instructionText: d.instructionText,
    fields,
  };
}

/* ── Prompt (mirrors src/ai/prompts.ts so behaviour is identical) ─────── */

function buildPrompt(req: VerifyRequest): string {
  const fieldLines = req.fields
    .map(
      (f, i) =>
        `${i + 1}. id=${f.id} | "${f.label}" | type=${f.type} | required=${f.required}${
          f.hint ? ` | form hint: ${f.hint}` : ''
        }\n   value: ${f.valueForCloud || '(khali)'}${
          f.valueRedacted ? '  [REDACTED — format facts only; never ask for or invent the value]' : ''
        }`,
    )
    .join('\n');

  return [
    'You are FormSathi Verify, a careful Indian form-filling reviewer.',
    "Check a filled form against the form's OWN official instructions.",
    '',
    `FORM: "${req.formTitle}" (${req.formType})`,
    '',
    'OFFICIAL INSTRUCTIONS (OCR, may be imperfect):',
    '"""',
    req.instructionText.slice(0, 6000),
    '"""',
    '',
    'FILLED FIELDS:',
    fieldLines,
    '',
    'CHECK: format problems, rule contradictions with the instructions, internal consistency, and empty required fields.',
    'PRIVACY: [REDACTED] values must be judged only from their `[format: ...]` facts. Never invent or echo a sensitive value; for those fields leave suggestedValue empty.',
    'STYLE: every reason in friendly Hinglish, one or two short sentences.',
    '',
    'OUTPUT JSON only: {"verdicts":[{"fieldId","status":"ok|warn|fix","reason","suggestedValue","rule"}],"summary","overallConfidence","instructionsUsed":[]}',
  ].join('\n');
}

/* ── The callable ─────────────────────────────────────────────────────── */

export const verifyForm = onCall(
  {
    region: 'asia-south1',
    secrets: [GEMINI_API_KEY],
    cors: true,
    enforceAppCheck: false, // set true once App Check is enabled in the console
    timeoutSeconds: 60,
    memory: '256MiB',
    maxInstances: 2, // free-tier friendly: never fan out into a bill
  },
  async (request: CallableRequest<unknown>) => {
    // Anonymous auth is enough: the function trusts no identity, it only
    // checks that the caller is signed in to your project.
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Anonymous sign-in required.');
    }

    const payload = validate(request.data);
    const prompt = buildPrompt(payload);

    const res = await fetch(ENDPOINT(GEMINI_MODEL, GEMINI_API_KEY.value()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      // Never leak the provider's error body (it can echo the prompt).
      throw new HttpsError('internal', `Verify backend returned ${res.status}.`);
    }

    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    if (!text) throw new HttpsError('internal', 'Empty response from verify backend.');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpsError('internal', 'Verify backend returned non-JSON.');
    }

    return {
      result: parsed,
      /** Provenance the client logs verbatim in the router. */
      meta: { model: GEMINI_MODEL, path: 'cloud-function', region: 'asia-south1' },
    };
  },
);
