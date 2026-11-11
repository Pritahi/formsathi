/**
 * Every prompt in FormSathi lives here, and every one of them is a SINGLE-TURN
 * prompt.
 *
 * Why this file looks like this
 * ─────────────────────────────
 * Firebase AI Logic's on-device path (Gemini Nano via Chrome's Prompt API)
 * supports single-turn generation only - `startChat()` and multi-turn history
 * are not available on device. The naive way to build an interview is a chat
 * loop; that silently pushes the whole interview to the cloud and guts the
 * product's privacy story.
 *
 * So the interview here is stateless from the model's point of view: each turn
 * packs (a) the form schema, (b) every answer collected so far, (c) the field
 * being asked about, and (d) the user's last utterance into one prompt and asks
 * for exactly one next question as JSON. The "conversation" lives in our state
 * machine (src/services/interview.ts), not in the model.
 *
 * Consequence worth bragging about in the write-up: any turn can be replayed
 * or resumed after a reload without a session transcript, which is why the
 * app survives airplane mode and tab eviction.
 *
 * Free-form chat (the "kuch bhi poochho" box) DOES need history, so it is
 * routed to the cloud on purpose - see ROUTE_TABLE in modelRouter.ts.
 */

import type { ExtractedField, FieldType, InterviewState } from '../lib/types';

/** The JSON contract the extractor must return. Kept as a string so the same
 *  text can be embedded in an on-device prompt and mirrored by the cloud
 *  responseSchema. */
export const EXTRACTION_JSON_SHAPE = `{
  "title": "form title as printed",
  "formType": "scholarship | government_scheme | exam | job | bank | other",
  "authority": "issuing body if printed, else empty string",
  "fields": [
    {
      "label": "label exactly as printed",
      "labelHi": "short Hindi/Hinglish rendering",
      "type": "text | number | date | phone | email | select | checkbox | signature",
      "required": true,
      "hint": "printed instruction next to the field, else empty string",
      "options": ["only for select"],
      "confidence": 0.0,
      "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }
    }
  ],
  "notes": ["anything the user should know, e.g. blur, cut-off edge"]
}`;

/**
 * EXTRACTION - runs ON-DEVICE.
 * Image in, JSON out. On-device supports text+image input (JPEG/PNG only) and
 * structured JSON output, which is exactly this task's shape.
 */
export function buildExtractionPrompt(): string {
  const langLine =
    'Write all labels and values in English.';

  return [
    'You are FormSathi, an assistant that reads Indian government, scholarship, exam and job forms from a photograph.',
    '',
    'TASK: Read the attached form image and list every fillable field.',
    '',
    'RULES:',
    '1. Only real fillable fields: boxes, blanks, dotted lines, checkbox groups. Skip headings, instructions paragraphs, signatures of officials, and footer text.',
    '2. Copy the label EXACTLY as printed, including bilingual text like "Name of Applicant / आवेदक का नाम".',
    '3. box = the field\'s writing area as fractions of the image width/height, values 0..1, origin top-left. Approximate is fine; it is used to draw an overlay.',
    '4. confidence 0..1 = how sure you are this is a genuine fillable field with that exact label. Blurry or ambiguous lines get under 0.5.',
    '5. type: date for dates, number for amounts/ages/percentages, phone for 10-digit mobiles, email for emails, select when a fixed choice list is printed, checkbox for tick boxes, signature for signature areas.',
    '6. required = true when the form marks it with * or says compulsory/anivarya.',
    '7. If the image is not a form, return fields: [] and explain in notes.',
    '',
    'OUTPUT: one JSON object, no markdown fences, no commentary, matching this shape exactly:',
    EXTRACTION_JSON_SHAPE,
    '',
    langLine,
  ].join('\n');
}

/** Validation / repair prompt for an extraction that came back malformed.
 *  Also single-turn: it receives the broken JSON inline. */
export function buildExtractionRepairPrompt(raw: string, error: string): string {
  return [
    'The following JSON is invalid or does not match the required shape.',
    `Problem: ${error}`,
    '',
    'Re-emit a corrected JSON object only. No markdown fences, no commentary.',
    'Required shape:',
    EXTRACTION_JSON_SHAPE,
    '',
    'BROKEN JSON:',
    raw.slice(0, 4000),
  ].join('\n');
}

/**
 * INTERVIEW TURN - runs ON-DEVICE, single turn, packed state.
 *
 * The prompt is deliberately under ~1200 characters for a 20-field form so
 * Nano stays fast on a laptop CPU/GPU. `remaining` is truncated to the next 6
 * fields because the model only needs enough context to pick a sensible order.
 */
export function buildInterviewPrompt(state: InterviewState, userInput?: string): string {
  const known = Object.entries(state.known)
    .map(([k, v]) => `- ${k}: ${redactForPrompt(k, v)}`)
    .join('\n') || '- (kuch nahi)';

  const remaining = state.remaining
    .slice(0, 6)
    .map((f) => `- ${f.id} | "${f.label}" | type=${f.type}${f.hint ? ` | hint=${f.hint}` : ''}`)
    .join('\n') || '- (koi nahi bacha)';

  const fieldsLeft = state.remaining.length;

  return [
    'You are FormSathi - a helpful friend who interviews the user to fill an Indian form.',
    'Hinglish = Hindi + English mix, Roman script, e.g. "What is your full name?"',
    '',
    `FORM: "${state.formTitle}" (${state.formType})`,
    'ALREADY FILLED:',
    known,
    '',
    'FIELDS LEFT (id | label | type):',
    remaining,
    `Total fields left: ${fieldsLeft}`,
    '',
    `CURRENT FIELD: ${state.currentFieldId}`,
    userInput ? `USER JUST SAID: "${userInput}"` : 'USER HAS NOT SAID ANYTHING YET',
    '',
    'TASK:',
    '1. If the user just said something, extract the answer for the CURRENT FIELD and treat it as known.',
    '2. Then ask the next question - short, one line, about just one field.',
    '3. If a field is already filled, do not ask it again.',
    '4. If no fields are left, set done=true and add a short closing line.',
    '5. Never repeat an Aadhaar/PAN/bank number in your question.',
    '',
    'STYLE: under 18 words. Use "aap". Use plain English and digits for numbers.',
    '',
    'OUTPUT: only one JSON object, no markdown fences:',
    '{',
    '  "question": "English question",',
    '  "fieldId": "field id being asked, or null",',
    '  "done": false,',
    '  "hint": "optional short tip",',
    '  "expects": "free_text | number | date | choice",',
    '  "options": ["only when expects=choice"]',
    '}',
  ].join('\n');
}

/**
 * ANSWER NORMALIZATION - runs ON-DEVICE.
 * Turns a spoken/typed answer into the exact format the field wants
 * ("fifty thousand" → "50000", "12 August 2004" → "2004-08-12"). This is where
 * a lot of real rejection-causing errors happen, so it is worth a dedicated
 * cheap call.
 */
export function buildNormalizePrompt(field: { label: string; type: FieldType; hint?: string }, raw: string): string {
  return [
    'FormSathi field value normalizer.',
    `FIELD: "${field.label}" (type=${field.type})${field.hint ? ` hint: "${field.hint}"` : ''}`,
    `USER ANSWER: "${raw}"`,
    '',
    'Convert the answer to the exact machine format this field expects.',
    'Rules:',
    '- number: digits only, no commas, no currency symbol, no units.',
    '- date: YYYY-MM-DD.',
    '- phone: 10 digits, no spaces, no +91.',
    '- text: keep the user\'s own wording, fix only obvious spelling of proper nouns.',
    '',
    'OUTPUT JSON only: {"value": "...", "confidence": 0.0, "note": "short note or empty"}',
  ].join('\n');
}

/**
 * CLOUD VERIFY - runs in the CLOUD, by design.
 *
 * Payload rule: we send the field SCHEMA, the FORMAT of each value, and the
 * official instruction text. Sensitive values (Aadhaar, PAN, bank, mobile,
 * DOB, address) are replaced by a shape descriptor before this prompt is even
 * built - see redact.ts. The cloud model can still catch "income should be
 * annual, not monthly" without ever seeing an identity number.
 */
export function buildCloudVerifyPrompt(opts: {
  formTitle: string;
  formType: string;
  instructionText: string;
  fields: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    hint?: string;
    /** already redacted / formatted for cloud consumption */
    valueForCloud: string;
    valueRedacted: boolean;
  }>;
}): string {
  const fieldLines = opts.fields
    .map((f, i) => {
      const val = f.valueForCloud ? `"${f.valueForCloud}"` : '(empty)';
      return `${i + 1}. id=${f.id} | "${f.label}" | type=${f.type} | required=${f.required}${
        f.hint ? ` | form hint: ${f.hint}` : ''
      }\n   value: ${val}${f.valueRedacted ? '  [REDACTED - format check only, do not read the value]' : ''}`;
    })
    .join('\n');

  return [
    'You are FormSathi Verify, a careful Indian form-filling reviewer.',
    'You check a filled form against the form\'s OWN official instructions.',
    '',
    `FORM: "${opts.formTitle}" (${opts.formType})`,
    '',
    'OFFICIAL INSTRUCTIONS (OCR of the instruction page, may be imperfect):',
    '"""',
    opts.instructionText.slice(0, 6000),
    '"""',
    '',
    'FILLED FIELDS:',
    fieldLines,
    '',
    'CHECK, in this order:',
    '1. FORMAT problems: income in words instead of figures, date in wrong order, mobile with +91/spaces, Aadhaar with spaces or fewer than 12 digits, pincode not 6 digits.',
    '2. RULE contradictions with the instructions above (age limit, income ceiling, required documents, category restrictions).',
    '3. INTERNAL consistency: income vs category claims, age vs date of birth, state vs address pincode.',
    '4. EMPTY required fields.',
    '',
    'PRIVACY - read this carefully. Some values are marked [REDACTED]. Those are personal identifiers your are NOT allowed to see; the device kept them. Instead you get a descriptor plus `[format: ...]` facts that the device already computed locally (digit counts, has-plus-prefix, has-spaces, ifsc-valid, numeric-only, iso-date ...).',
    'Use those facts as EVIDENCE. For example `[format: digits=12, chars=12, has-plus-prefix]` on a mobile field means the +91 rule is broken even though you never saw the number. Do not ask for the value. Do not invent one. Never put a sensitive value in suggestedValue - for those fields give the corrected FORMAT in `reason` and leave suggestedValue empty.',
    '',
    'STYLE for every reason: English, one or two short sentences, friendly, no scolding. Example: "Income written as 5000 - the scheme limit is ₹2,50,000 per year, so this looks like monthly income. Write the annual income instead."',
    '',
    'OUTPUT: one JSON object, no markdown fences:',
    '{',
    '  "verdicts": [',
    '    { "fieldId": "...", "status": "ok | warn | fix", "reason": "English reason", "suggestedValue": "only when status=fix AND the value is not redacted", "rule": "which instruction line" }',
    '  ],',
    '  "summary": "2 line English summary of the whole form",',
    '  "overallConfidence": 0.0,',
    '  "instructionsUsed": ["short quotes of the lines you relied on"]',
    '}',
    '',
    'Only include verdicts for fields that have an issue, plus "ok" entries for required fields you checked. Do not invent problems to look busy.',
  ].join('\n');
}

/**
 * REVIEW SUMMARY - runs in the CLOUD.
 * A calm human-readable wrap-up with the traffic-light counts, used on the
 * final screen and as the WhatsApp-shareable text.
 */
export function buildReviewSummaryPrompt(opts: {
  formTitle: string;
  counts: { green: number; yellow: number; red: number };
  issues: Array<{ label: string; reason: string }>;
  instructionAvailable: boolean;
}): string {
  return [
    'Write a short English review summary for a person who just filled an Indian form.',
    `FORM: "${opts.formTitle}"`,
    `STATUS: ${opts.counts.green} fields are good, ${opts.counts.yellow} need attention, ${opts.counts.red} are empty.`,
    `ISSUES: ${opts.issues.length ? opts.issues.map((i) => `${i.label}: ${i.reason}`).join(' | ') : 'none'}`,
    `OFFICIAL INSTRUCTIONS AVAILABLE: ${opts.instructionAvailable ? 'yes' : 'no'}`,
    '',
    'Return JSON only:',
    '{ "summary": "3-4 short English sentences", "nextSteps": ["2-3 short English action items"], "confidence": 0.0 }',
    '',
    'Be honest and specific. If instructions were not provided, say that you could only check format, not scheme rules.',
  ].join('\n');
}

/**
 * FREE-FORM CHAT - routed to CLOUD on purpose.
 * This is the one place the product genuinely needs multi-turn history
 * (a user asking "aur yeh document chahiye kya?" three questions deep), and
 * on-device does not support multi-turn. Routing it to cloud is the honest
 * design choice, and the router log shows it as `freeform_chat → cloud`.
 */
export function buildFreeformChatPrompt(history: Array<{ role: 'user' | 'model'; text: string }>, question: string): string {
  const convo = history
    .slice(-6)
    .map((h) => `${h.role === 'user' ? 'USER' : 'FORMSATHI'}: ${h.text}`)
    .join('\n');
  return [
    'You are FormSathi - a form-filling helper replying in English.',
    'Give short, direct answers (max 3 sentences). Give practical advice about filling the form.',
    'Never repeat Aadhaar/PAN-style numbers. Do not give legal or financial guarantees.',
    '',
    convo ? `EARLIER CONVERSATION:\n${convo}\n` : '',
    `USER: ${question}`,
    'FORMSATHI:',
  ].join('\n');
}

/** Sensitive-looking values are masked inside interview prompts: Nano only
 *  needs to know "answer given", not the digits, and this keeps Aadhaar out of
 *  any accidental prompt logging in devtools. */
function redactForPrompt(key: string, value: string): string {
  const sensitive = /aadha|aadhar|pan|bank|account|ifsc|mobile|phone|address|dob|income/i.test(key);
  if (!sensitive) return value.slice(0, 60);
  if (!value) return '(empty)';
  return value.length > 4 ? `${'*'.repeat(Math.min(8, value.length - 2))}${value.slice(-2)}` : '****';
}

/* ── Cloud structured-output schemas ───────────────────────────────────── */

/** JSON schema (OpenAPI-subset) handed to the cloud model so its output is
 *  guaranteed parseable. The on-device path cannot take a schema through this
 *  SDK - it relies on the prompt-level JSON contract above, and the router
 *  re-asks with a repair prompt if the shape is wrong. */
export const CLOUD_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fieldId: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'warn', 'fix'] },
          reason: { type: 'string' },
          suggestedValue: { type: 'string' },
          rule: { type: 'string' },
        },
        required: ['fieldId', 'status'],
      },
    },
    summary: { type: 'string' },
    overallConfidence: { type: 'number' },
    instructionsUsed: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdicts', 'summary', 'overallConfidence'],
} as const;

export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    formType: { type: 'string' },
    authority: { type: 'string' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          labelHi: { type: 'string' },
          type: { type: 'string' },
          required: { type: 'boolean' },
          hint: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          box: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
          },
        },
        required: ['label', 'type'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'fields'],
} as const;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    nextSteps: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['summary'],
} as const;

/** Types the model is allowed to emit, normalized in one place. */
export const VALID_FIELD_TYPES: FieldType[] = [
  'text',
  'number',
  'date',
  'phone',
  'email',
  'select',
  'checkbox',
  'signature',
];

export function coerceFieldType(raw: unknown): FieldType {
  const t = String(raw ?? '').toLowerCase();
  return (VALID_FIELD_TYPES as string[]).includes(t) ? (t as FieldType) : 'text';
}

/** Used by the router when a model returns a plausible-but-thin field list. */
export function isThinExtraction(fields: ExtractedField[]): boolean {
  return fields.length === 0;
}
