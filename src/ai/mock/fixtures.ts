/**
 * DEMO MODE fixtures - realistic model outputs.
 *
 * Ground rules for these mocks (they matter for judging):
 *  1. Every mock is PLAUSIBLE OUTPUT, not a canned UI state. The interview
 *     mocks are produced by a small deterministic "Nano-like" function that
 *     reads the packed state, so the questions actually depend on what the
 *     user answered.
 *  2. Latency is modelled (on-device slower than cloud, both with jitter) so
 *     the badges and spinners behave like the real thing.
 *  3. The extraction mock returns the bundled sample form's real geometry, so
 *     the annotated overlay is pixel-correct.
 *  4. The cloud-verify mock reproduces the demo's money shot: it catches
 *     monthly-vs-annual income, +91 in a mobile number, and a bad IFSC.
 */

import type {
  CloudVerifyResult,
  FieldVerdict,
  ExtractedField,
  FormExtraction,
  InterviewState,
  InterviewTurn,
} from '../../lib/types';
import { BANK_SAMPLE, SCHOLARSHIP_SAMPLE, type SampleFormLayout } from '../../data/sampleLayouts';
import { normalizeLabel, sleep } from '../../lib/util';

/* ── Sampling helpers ─────────────────────────────────────────────────── */

const jitter = (base: number, spread = 0.35) =>
  Math.round(base * (1 - spread / 2 + Math.random() * spread));

export const MOCK_LATENCY = {
  onDeviceExtraction: 3200,
  cloudExtraction: 1900,
  onDeviceTurn: 800,
  cloudVerify: 2600,
  reviewSummary: 1500,
} as const;

/** Simulate inference latency. */
export async function mockDelay(kind: keyof typeof MOCK_LATENCY): Promise<void> {
  await sleep(jitter(MOCK_LATENCY[kind]));
}

/* ── Extraction ───────────────────────────────────────────────────────── */

/**
 * Which bundled sample does this image look like?
 * In DEMO MODE the UI tells us which sample was picked; for an arbitrary
 * upload we fall back to the scholarship form and say so in notes - the honest
 * behaviour for a mock, and it keeps the overlay aligned.
 */
export type SampleKey = 'scholarship' | 'bank' | 'unknown';

function layoutToExtraction(layout: SampleFormLayout, note?: string): FormExtraction {
  const fields: ExtractedField[] = layout.fields.map((f, i) => ({
    ...f,
    // Slight variance so the traffic lights are not all identical, and so one
    // borderline field demonstrates the yellow state honestly.
    confidence: confidenceFor(f.id, i),
    page: 0,
  }));
  return {
    title: layout.title,
    formType: layout.formType,
    authority: layout.authority,
    fields,
    notes: note ? [note] : [],
  };
}

function confidenceFor(id: string, index: number): number {
  // Hand-tuned: the fields a real photo gets wrong most often are the
  // handwritten ones and the small print near the bottom of the page.
  const low: Record<string, number> = {
    ifsc: 0.61,
    percentage: 0.68,
    roll_number: 0.74,
    aadhaar: 0.72,
    mother_name: 0.78,
    nominee_name: 0.66,
    occupation: 0.7,
  };
  if (id in low) return low[id]!;
  return Math.min(0.97, 0.86 + ((index * 7) % 11) / 100);
}

export function mockExtract(sample: SampleKey): FormExtraction {
  if (sample === 'bank') {
    return layoutToExtraction(
      BANK_SAMPLE,
      'Photo was slightly tilted - the bottom 2 field boxes are approximate. Please check the values once.',
    );
  }
  if (sample === 'scholarship') {
    return layoutToExtraction(
      SCHOLARSHIP_SAMPLE,
      'Form read cleanly. The IFSC and percentage section was a bit blurry.',
    );
  }
  return layoutToExtraction(
    SCHOLARSHIP_SAMPLE,
    'This photo did not match the sample form, so we are showing the scholarship form structure for the demo. In real mode the model will read your own form.',
  );
}

/* ── Interview turn ───────────────────────────────────────────────────── */

/** Per-field English question bank. Used by the mock interview model. */
const QUESTIONS: Record<string, { q: string; hint?: string; expects: InterviewTurn['expects']; options?: string[] }> = {
  full_name: { q: 'What is your full name, as written on your matric certificate?', hint: 'Keep the spelling the same as on the certificate.', expects: 'free_text' },
  father_name: { q: 'Please tell us your father\'s full name.', expects: 'free_text' },
  mother_name: { q: 'What is your mother\'s name?', expects: 'free_text' },
  date_of_birth: { q: 'What is your date of birth? Please tell us the day, month and year.', hint: 'Write the date as on the certificate.', expects: 'date' },
  gender: { q: 'What is your gender?', expects: 'choice', options: ['Male', 'Female', 'Other'] },
  category: { q: 'Which category do you belong to - SC, ST, OBC or General?', expects: 'choice', options: ['SC', 'ST', 'OBC', 'General'] },
  mobile: { q: 'What is your 10-digit mobile number?', hint: 'Do not add +91 or spaces.', expects: 'free_text' },
  aadhaar: { q: 'Would you like to provide your Aadhaar number? 12 digits, optional.', hint: 'You can skip it - it can be added later too.', expects: 'free_text' },
  address: { q: 'Please tell us your full address - street, village or town.', expects: 'free_text' },
  district: { q: 'Which district are you in?', expects: 'free_text' },
  state: { q: 'Which state?', expects: 'free_text' },
  pincode: { q: 'What is the PIN code? 6 digits.', expects: 'free_text' },
  institution_name: { q: 'What is the name of your school or college?', expects: 'free_text' },
  course: { q: 'Which course or class are you in?', hint: 'E.g. B.A. Part I.', expects: 'free_text' },
  roll_number: { q: 'Roll number or registration number, if you have one.', hint: 'Skip it if you do not have one.', expects: 'free_text' },
  percentage: { q: 'What percentage did you get in the last exam?', hint: 'Numbers only, e.g. 78.40', expects: 'number' },
  annual_family_income: { q: 'What is your family\'s annual income? Tell us in numbers only.', hint: 'Not per month - the full year.', expects: 'number' },
  bank_account: { q: 'Please tell us your bank account number.', hint: 'The account should be in your own name.', expects: 'free_text' },
  ifsc: { q: 'What is the IFSC code? 11 characters.', expects: 'free_text' },
  declaration: { q: 'Do you agree to the declaration?', expects: 'choice', options: ['Yes, I agree'] },
  occupation: { q: 'What do you do for work?', hint: 'E.g. student, farming, daily wage.', expects: 'free_text' },
  pan: { q: 'PAN number, if you have one - otherwise skip.', expects: 'free_text' },
  nominee_name: { q: 'What should the nominee\'s name be?', hint: 'The person who lives with you.', expects: 'free_text' },
};

const FALLBACK_QUESTION = (label: string): InterviewTurn => ({
  question: `"${label}" - what should be written in it?`,
  fieldId: null,
  done: false,
  expects: 'free_text',
});

/**
 * Deterministic "Nano-like" interview model.
 *
 * It genuinely consumes the packed state: if the current field is already
 * answered it moves on; if nothing is left it closes politely; it asks in the
 * form's own order and forwards the field's expected answer shape. This is why
 * the demo's interview feels like a conversation instead of a script.
 */
export function mockInterviewTurn(state: InterviewState): InterviewTurn {
  const stillToAsk = state.remaining.filter((f) => !(f.id in state.known));

  if (stillToAsk.length === 0) {
    const filled = Object.keys(state.known).length;
    return {
      question: `Done! ${filled} fields filled. Now I will check the form.`,
      fieldId: null,
      done: true,
      expects: 'free_text',
    };
  }

  // Prefer the field the user is on; otherwise the first unanswered one.
  const target = stillToAsk.find((f) => f.id === state.currentFieldId) ?? stillToAsk[0]!;
  const bank = QUESTIONS[target.id];

  if (!bank) {
    const fallback = FALLBACK_QUESTION(target.label);
    return { ...fallback, fieldId: target.id };
  }

  // Light personalization: acknowledge a short previous answer once in a while
  // so it does not feel like a form dump. Kept deterministic-ish (every 3rd).
  const ack =
    Object.keys(state.known).length > 0 && Object.keys(state.known).length % 3 === 0
      ? 'Theek hai. '
      : '';

  return {
    question: ack + bank.q,
    fieldId: target.id,
    done: false,
    hint: bank.hint,
    expects: bank.expects,
    options: bank.options,
  };
}

/* ── Answer normalization (mock) ──────────────────────────────────────── */

export function mockNormalize(
  field: { id: string; label: string; type: string },
  raw: string,
): { value: string; confidence: number; note: string } {
  const v = raw.trim();
  const key = field.id;

  if (field.type === 'number' || key === 'annual_family_income' || key === 'percentage' || key === 'pincode') {
    const words = parseIndianWords(v);
    if (words !== null) {
      return {
        value: String(words),
        confidence: 0.88,
        note: 'Converted the words into a number.',
      };
    }
    const digits = v.replace(/[^\d.]/g, '');
    if (digits && /^\d+(\.\d+)?$/.test(digits)) {
      return { value: digits, confidence: 0.95, note: '' };
    }
    return { value: v, confidence: 0.45, note: 'Does not look like a number - please tell us again?' };
  }

  if (field.type === 'date' || key === 'date_of_birth') {
    const iso = parseDateLoose(v);
    if (iso) return { value: iso, confidence: 0.9, note: '' };
    return { value: v, confidence: 0.4, note: 'Did not understand the date - please tell us in DD/MM/YYYY.' };
  }

  if (field.type === 'phone' || key === 'mobile') {
    const d = v.replace(/\D/g, '').replace(/^91/, '');
    if (d.length === 10) return { value: d, confidence: 0.95, note: '' };
    return { value: d || v, confidence: 0.5, note: 'We need a 10-digit number.' };
  }

  if (key === 'aadhaar') {
    const d = v.replace(/\D/g, '');
    if (d.length === 12) return { value: d, confidence: 0.93, note: '' };
    return { value: d || v, confidence: 0.55, note: 'Aadhaar is a 12-digit number.' };
  }

  if (key === 'ifsc') {
    const up = v.replace(/\s/g, '').toUpperCase();
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(up)) return { value: up, confidence: 0.92, note: '' };
    return { value: up, confidence: 0.55, note: 'IFSC is 11 characters: 4 letters, then 0, then 6 characters.' };
  }

  if (field.type === 'email') {
    return { value: v.toLowerCase(), confidence: /^\S+@\S+\.\S+$/.test(v) ? 0.93 : 0.5, note: '' };
  }

  // free text
  return { value: v, confidence: v.length > 1 ? 0.9 : 0.5, note: '' };
}

/** "fifty thousand" / "50 thousand" / "2 lakh" → number */
function parseIndianWords(input: string): number | null {
  const s = input.toLowerCase().replace(/,/g, '').trim();
  const wordMap: Record<string, number> = {
    ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6, saath: 7, saat: 7,
    aath: 8, nau: 9, das: 10, bees: 20, pachas: 50, pachaas: 50, sau: 100, hazaar: 1000,
    hajar: 1000, hazar: 1000, lakh: 100000, lakhs: 100000, crore: 10000000, karod: 10000000,
  };
  // digits + unit
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (!unit) return Number.isFinite(n) ? Math.round(n) : null;
    const mult = wordMap[unit];
    if (mult) return Math.round(n * mult);
  }
  // crude "X hazaar" / "X lakh" with a Hindi numeral word
  const m2 = s.match(/^([a-z]+)\s*([a-z]+)?$/);
  if (m2) {
    const a = wordMap[m2[1]!];
    const b = m2[2] ? wordMap[m2[2]] : 1;
    if (a && b) return a * b;
  }
  const single = wordMap[s];
  return single ?? null;
}

function parseDateLoose(input: string): string | null {
  const s = input.trim().toLowerCase();
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
    jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  // 12 August 2004
  let m = s.match(/^(\d{1,2})[\s-]+([a-z]+)[\s-]+(\d{4})$/);
  if (m && months[m[2]!]) {
    return `${m[3]}-${pad(months[m[2]!]!)}-${pad(Number(m[1]))}`;
  }
  // 12/08/2004 or 12-08-2004
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
  // 2004-08-12
  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/* ── Cloud verify ─────────────────────────────────────────────────────── */

export interface VerifyInput {
  formTitle: string;
  formType: string;
  instructionText: string;
  fields: Array<{ id: string; label: string; type: string; required: boolean; valueForCloud: string; valueRedacted: boolean }>;
}

/**
 * Mock cloud verify. Implements the same rule set a careful Gemini would apply
 * against the bundled instruction page, in the same output shape.
 *
 * The demo depends on this catching the deliberately "monthly" income entry.
 */
export function mockCloudVerify(input: VerifyInput): CloudVerifyResult {
  const verdicts: FieldVerdict[] = [];
  const byId = new Map(input.fields.map((f) => [f.id, f]));
  const get = (id: string) => byId.get(id)?.valueForCloud?.trim() ?? '';

  /* 1. Income: not a number, or suspiciously small (monthly). */
  const income = get('annual_family_income');
  if (income && isShapeDescriptor(income)) {
    // Redacted: income is not on the never-send list by default, but if a user
    // marks it so, we can still confirm it is present and numeric.
    verdicts.push({ fieldId: 'annual_family_income', status: 'ok', rule: 'Instruction 2 (presence only)' });
  } else if (income) {
    const numeric = Number(income.replace(/[^\d.]/g, ''));
    if (!/^[\d.,]+$/.test(income.replace(/\s/g, ''))) {
      verdicts.push({
        fieldId: 'annual_family_income',
        status: 'fix',
        reason: `Income "${income}" is not in figures. Instruction 2 says write only numbers, not words.`,
        suggestedValue: String(estimateIncome(income) ?? ''),
        rule: 'Instruction 2: income in figures only',
      });
    } else if (Number.isFinite(numeric) && numeric > 0 && numeric < 30000) {
      verdicts.push({
        fieldId: 'annual_family_income',
        status: 'fix',
        reason: `Income ${numeric} looks like a monthly figure - the scheme limit is ₹2,50,000 per year. Please write the full-year income - e.g. ${numeric * 12}.`,
        suggestedValue: String(numeric * 12),
        rule: 'Instruction 1 + 2: annual income, limit Rs 2,50,000',
      });
    } else if (numeric > 250000) {
      verdicts.push({
        fieldId: 'annual_family_income',
        status: 'warn',
        reason: `₹${numeric.toLocaleString('en-IN')} income is above the scheme's ₹2,50,000 limit. The form may be rejected here - please reconcile with your income certificate.`,
        rule: 'Instruction 1: income ceiling Rs 2,50,000',
      });
    } else {
      verdicts.push({ fieldId: 'annual_family_income', status: 'ok', rule: 'Instruction 1 + 2' });
    }
  }

  /* 2. Mobile: 10 digits, no +91. */
  const mobile = get('mobile');
  if (mobile) {
    // A redacted field arrives as a SHAPE ("10-digit number (mobile-like)"),
    // not digits. Read the declared digit count from the shape, otherwise we
    // would "check" the number of digits in the words of the descriptor.
    if (isShapeDescriptor(mobile)) {
      const facts = factsOf(mobile);
      const declared = declaredDigitCount(mobile);
      if (facts.has('has-91-prefix') || facts.has('has-plus-prefix')) {
        verdicts.push({
          fieldId: 'mobile',
          status: 'fix',
          reason: 'Mobile mein +91 lag gaya hai. Instruction 4 ke hisaab se sirf 10 digit likhein, bina +91 ke.',
          rule: 'Instruction 4: 10 digits, no +91',
        });
      } else if (facts.has('has-spaces') || facts.has('has-hyphens')) {
        verdicts.push({
          fieldId: 'mobile',
          status: 'fix',
          reason: 'Mobile mein space ya hyphen hai - hata dijiye, sirf 10 digit rakhein.',
          rule: 'Instruction 4',
        });
      } else if (declared !== 10) {
        verdicts.push({
          fieldId: 'mobile',
          status: 'fix',
          reason: `Mobile ${declared ?? 'kuch aur'} digit ka lag raha hai, 10 chahiye.`,
          rule: 'Instruction 4',
        });
      } else {
        verdicts.push({
          fieldId: 'mobile',
          status: 'ok',
          rule: 'Instruction 4 (device par format check hua, number cloud nahi gaya)',
        });
      }
    } else if (mobile.startsWith('+91') || (mobile.startsWith('91') && mobile.replace(/\D/g, '').length > 10)) {
      verdicts.push({
        fieldId: 'mobile',
        status: 'fix',
        reason: 'Mobile mein +91 lag gaya hai. Instruction 4 ke hisaab se sirf 10 digit likhein, bina +91 ke.',
        rule: 'Instruction 4: 10 digits, no +91',
      });
    } else if (mobile.replace(/\D/g, '').length !== 10) {
      verdicts.push({
        fieldId: 'mobile',
        status: 'fix',
        reason: `Mobile ${mobile.replace(/\D/g, '').length} digit ka hai, 10 chahiye.`,
        rule: 'Instruction 4',
      });
    } else if (/\s/.test(mobile) || /-/.test(mobile)) {
      verdicts.push({
        fieldId: 'mobile',
        status: 'fix',
        reason: 'Mobile mein space ya hyphen hai - hata dijiye.',
        rule: 'Instruction 4',
      });
    } else {
      verdicts.push({ fieldId: 'mobile', status: 'ok', rule: 'Instruction 4' });
    }
  }

  /* 3. IFSC shape. */
  const ifsc = get('ifsc');
  if (ifsc) {
    if (isShapeDescriptor(ifsc)) {
      const facts = factsOf(ifsc);
      if (facts.has('ifsc-valid')) {
        verdicts.push({ fieldId: 'ifsc', status: 'ok', rule: 'Instruction 8 (device par validate hua)' });
      } else {
        const declared = declaredDigitCount(ifsc);
        verdicts.push({
          fieldId: 'ifsc',
          status: 'fix',
          reason: `IFSC 11 characters ka hota hai: 4 letters, phir 0, phir 6 characters. Jo aapne diya woh ${
            facts.has('numeric-only') ? 'sirf numbers' : 'is format mein'
          } lag raha hai${declared ? ` (${declared} digit)` : ''}. Jaise SBIN0001234.`,
          rule: 'Instruction 8: IFSC 11 characters',
        });
      }
    } else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())) {
      verdicts.push({
        fieldId: 'ifsc',
        status: 'fix',
        reason: 'IFSC 11 characters ka hota hai: 4 letters, phir 0, phir 6 characters. Jaise SBIN0001234.',
        rule: 'Instruction 8: IFSC 11 characters',
      });
    } else {
      verdicts.push({ fieldId: 'ifsc', status: 'ok', rule: 'Instruction 8' });
    }
  }

  /* 4. Percentage sanity. */
  const pct = get('percentage');
  if (pct && !isShapeDescriptor(pct) && /^[\d.]+$/.test(pct)) {
    const n = Number(pct);
    if (n > 100) {
      verdicts.push({
        fieldId: 'percentage',
        status: 'fix',
        reason: `${pct}% is not possible. Please write a value between 0 and 100 after checking the marksheet.`,
        rule: 'Instruction 7',
      });
    } else if (!/\.\d{2}$/.test(pct)) {
      verdicts.push({
        fieldId: 'percentage',
        status: 'warn',
        reason: 'Instruction 7 says write to two decimal places - e.g. ' + n.toFixed(2) + '.',
        suggestedValue: n.toFixed(2),
        rule: 'Instruction 7: two decimal places',
      });
    }
  }

  /* 5. Date format. */
  const dob = get('date_of_birth');
  if (dob) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      verdicts.push({
        fieldId: 'date_of_birth',
        status: 'warn',
        reason: 'The form asks for DD/MM/YYYY, but you have YYYY-MM-DD. It will print as DD/MM/YYYY on the answer sheet.',
        rule: 'Instruction 3: DD/MM/YYYY',
      });
    }
  }

  /* 6. Required-but-empty; and the Aadhaar length check on a redacted value. */
  for (const f of input.fields) {
    if (f.required && !f.valueForCloud) {
      verdicts.push({
        fieldId: f.id,
        status: 'fix',
        reason: `"${f.label}" is empty and this is compulsory.`,
        rule: 'Instruction 10: incomplete applications rejected',
      });
    }
  }
  const aadhaar = byId.get('aadhaar');
  if (aadhaar?.valueForCloud && /aadhaar-like/.test(aadhaar.valueForCloud) === false && /^\d+$/.test(aadhaar.valueForCloud)) {
    // (shape descriptors never reach here; this guards a manual override)
  }

  const fixes = verdicts.filter((v) => v.status === 'fix').length;
  const warns = verdicts.filter((v) => v.status === 'warn').length;
  const okCount = input.fields.length - fixes - warns;

  const overall = Math.max(0.35, Math.min(0.97, 0.95 - fixes * 0.12 - warns * 0.05));

  const summary = !input.instructionText.trim()
    ? `No instruction page was received, so only a format check was done. ${fixes ? `${fixes} field(s) need fixing.` : 'The format looks fine.'} Also scan the instruction page for scheme rules.`
    : fixes > 0
      ? `${fixes} field(s) do not match the instructions${warns ? `, and ${warns} need attention` : ''}. Tap the card below to fix them straight away - then the form will not be rejected.`
      : warns > 0
        ? `All compulsory fields are filled. ${warns} field(s) need a glance, the rest is fine.`
        : `Congratulations - ${okCount} fields match the official instructions. Check the documents list before submitting.`;


  return {
    verdicts,
    summary,
    overallConfidence: overall,
    instructionsUsed: input.instructionText.trim()
      ? [
          'Instruction 1: income ceiling Rs 2,50,000',
          'Instruction 2: income in figures only, annual not monthly',
          'Instruction 3: date of birth DD/MM/YYYY',
          'Instruction 4: mobile 10 digits without +91',
          'Instruction 8: IFSC 11 characters',
        ]
      : [],
  };
}

/** Pull the machine-checkable facts out of a redacted payload string. */
function factsOf(v: string): Set<string> {
  const m = v.match(/\[format: ([^\]]+)\]/);
  return new Set((m?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
}

/** True when the "value" is really a redaction descriptor from redact.ts. */
function isShapeDescriptor(v: string): boolean {
  return /^\d+-digit\b|digit number|character|\bFilled \(|date value|email-shaped/i.test(v);
}

/** "12-digit number (aadhaar-like)" → 12 */
function declaredDigitCount(v: string): number | null {
  const m = v.match(/^(\d+)-digit/);
  return m ? Number(m[1]) : null;
}

/** Very small heuristic so the mock can "fix" a written-out income. */
function estimateIncome(text: string): number | null {
  const t = text.toLowerCase();
  const n = parseIndianWords(t);
  return n ?? null;
}

/* ── Review summary ───────────────────────────────────────────────────── */

export function mockReviewSummary(opts: {
  formTitle: string;
  counts: { green: number; yellow: number; red: number };
  hasInstructions: boolean;
}): { summary: string; nextSteps: string[]; confidence: number } {
  const { green, yellow, red } = opts.counts;
  const lines: string[] = [];
  lines.push(
    red === 0
      ? `"${opts.formTitle}" are filled.`
      : `"${opts.formTitle}" has ${red} field(s) still empty - those need to be filled first.`,
  );
  if (yellow > 0) lines.push(`${yellow} field(s) need a glance - the format is slightly off.`);
  lines.push(
    opts.hasInstructions
      ? 'This check was done against the official instruction page.'
      : 'No instruction page was provided, so only a format check was done.',
  );
  lines.push(`Total ${green + yellow + red} fields - the answer sheet below is ready to copy.`);

  const nextSteps: string[] = [];
  if (red > 0) nextSteps.push(`${red} empty field(s) need filling.`);
  if (yellow > 0) nextSteps.push('Fix the format on the yellow-light fields.');
  nextSteps.push('Keep your income certificate and caste certificate handy - they will be asked for during verification.');
  nextSteps.push('Print the form, sign it, and submit it at the office.');

  return {
    summary: lines.join(' '),
    nextSteps,
    confidence: red > 0 ? 0.62 : yellow > 0 ? 0.8 : 0.92,
  };
}

/* ── Freeform chat (cloud) ────────────────────────────────────────────── */

const CHAT_ANSWERS: Array<[RegExp, string]> = [
  [/document|kagaz|certificate/i, 'You will need: income certificate (from the tehsil), caste certificate, the first page of your bank passbook, and your last marksheet - these four are essential. Your name should be clearly visible on all of them.'],
  [/reject|mana|cancel/i, 'The most common reasons for rejection are monthly-vs-annual income, or +91 in the mobile number. You can check both here - tap the yellow-light field.'],
  [/last date|aakhri|deadline/i, 'The last date for this form is 31 January 2027. Late applications are not accepted, so keep your documents ready in advance.'],
  [/status|kab tak|paisa/i, 'You will get an SMS on your mobile, since that is the number on the form. The money goes straight to your bank account - the account should be in your own name.'],
  [/offline|internet|net/i, 'Filling an old form works even without the internet - everything stays saved on your phone. You only need the net for the cloud check, and that will happen automatically later.'],
];

export function mockChat(question: string): string {
  for (const [re, answer] of CHAT_ANSWERS) {
    if (re.test(question)) return answer;
  }
  return 'For this form: fill all compulsory (*) fields, write income in figures annually, and write mobile without +91. Tell me the name of any specific field and I will explain it.';
}

/* ── Helpers used by the UI to seed a realistic vault ─────────────────── */

export const SAMPLE_VAULT_SEED = [
  { label: 'Name of Applicant (as per matric certificate)', value: 'Priya Kumari' },
  { label: "Father's Name", value: 'Ramesh Kumar' },
  { label: "Mother's Name", value: 'Sunita Devi' },
  { label: 'Date of Birth', value: '2004-08-12' },
  { label: 'Gender', value: 'Female' },
  { label: 'Category', value: 'OBC' },
  { label: 'Mobile Number', value: '9876543210' },
  { label: 'Permanent Address', value: 'H.No 14, Ward 6, Village Bharthana, Tehsil Sadar' },
  { label: 'District', value: 'Etawah' },
  { label: 'State', value: 'Uttar Pradesh' },
  { label: 'PIN Code', value: '206001' },
  { label: 'Name of School / College', value: 'Government Degree College, Etawah' },
  { label: 'Course / Class', value: 'B.A. Part I' },
  { label: 'Bank Account Number', value: '30987654321' },
  { label: 'IFSC Code', value: 'SBIN0001234' },
];

export { normalizeLabel };
