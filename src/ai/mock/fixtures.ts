/**
 * DEMO MODE fixtures — realistic model outputs.
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
 * upload we fall back to the scholarship form and say so in notes — the honest
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
      'Photo thodi tirchi thi — neeche ke 2 fields ka box approx hai. Values ek baar check kar lijiye.',
    );
  }
  if (sample === 'scholarship') {
    return layoutToExtraction(
      SCHOLARSHIP_SAMPLE,
      'Form saaf padha gaya. IFSC aur percentage wala hissa thoda blur tha.',
    );
  }
  return layoutToExtraction(
    SCHOLARSHIP_SAMPLE,
    'Yeh photo sample form se match nahi hui, isliye demo ke liye scholarship form ka structure dikha rahe hain. Asli mode mein model aapki hi form padhega.',
  );
}

/* ── Interview turn ───────────────────────────────────────────────────── */

/** Per-field Hinglish question bank. Used by the mock interview model. */
const QUESTIONS: Record<string, { q: string; hint?: string; expects: InterviewTurn['expects']; options?: string[] }> = {
  full_name: { q: 'Aapka poora naam kya hai, jaise matric certificate par likha hai?', hint: 'Spelling wahi rakhein jo certificate par hai.', expects: 'free_text' },
  father_name: { q: 'Papa ka poora naam bata dijiye.', expects: 'free_text' },
  mother_name: { q: 'Maa ka naam likhna hai — kya likhein?', expects: 'free_text' },
  date_of_birth: { q: 'Aapki date of birth kya hai? Din, mahina aur saal bata dijiye.', hint: 'Certificate wali date hi likhein.', expects: 'date' },
  gender: { q: 'Aapka gender kya hai?', expects: 'choice', options: ['Male', 'Female', 'Other'] },
  category: { q: 'Aap kis category mein aate hain — SC, ST, OBC ya General?', expects: 'choice', options: ['SC', 'ST', 'OBC', 'General'] },
  mobile: { q: 'Aapka 10 digit ka mobile number kya hai?', hint: '+91 ya space nahi lagayenge.', expects: 'free_text' },
  aadhaar: { q: 'Aadhaar number dena chahenge? 12 digit, optional hai.', hint: 'Skip kar sakte hain, baad mein bhi chalega.', expects: 'free_text' },
  address: { q: 'Ghar ka poora pata bataiye — gali, gaon ya shehar.', expects: 'free_text' },
  district: { q: 'Aapka district kaunsa hai?', expects: 'free_text' },
  state: { q: 'State kaunsi hai?', expects: 'free_text' },
  pincode: { q: 'PIN code kya hai? 6 digit wala.', expects: 'free_text' },
  institution_name: { q: 'School ya college ka naam kya hai?', expects: 'free_text' },
  course: { q: 'Kaunsa course ya class kar rahe hain?', hint: 'Jaise B.A. Part I.', expects: 'free_text' },
  roll_number: { q: 'Roll number ya registration number hai to bata dijiye.', hint: 'Na ho to chhod dijiye.', expects: 'free_text' },
  percentage: { q: 'Pichhle exam mein kitne percent marks aaye?', hint: 'Sirf numbers, jaise 78.40', expects: 'number' },
  annual_family_income: { q: 'Ghar ki saalana income kitni hai? Sirf numbers mein bataiye.', hint: 'Mahine ki nahi, poore saal ki.', expects: 'number' },
  bank_account: { q: 'Bank account number bata dijiye.', hint: 'Account aapke hi naam par hona chahiye.', expects: 'free_text' },
  ifsc: { q: 'IFSC code kya hai? 11 characters ka.', expects: 'free_text' },
  declaration: { q: 'Declaration se aap agree hain?', expects: 'choice', options: ['Yes, I agree'] },
  occupation: { q: 'Aap kya kaam karte hain?', hint: 'Jaise student, kheti, mazdoori.', expects: 'free_text' },
  pan: { q: 'PAN number hai to bataiye, warna chhod dein.', expects: 'free_text' },
  nominee_name: { q: 'Nominee ka naam kya likhein?', hint: 'Jo aapke saath rehta ho.', expects: 'free_text' },
};

const FALLBACK_QUESTION = (label: string): InterviewTurn => ({
  question: `"${label}" — ismein kya likhein?`,
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
      question: `Bas ho gaya! ${filled} fields bhar gaye hain. Ab main form check kar deta hoon.`,
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
        note: 'Shabdon ko number mein badal diya.',
      };
    }
    const digits = v.replace(/[^\d.]/g, '');
    if (digits && /^\d+(\.\d+)?$/.test(digits)) {
      return { value: digits, confidence: 0.95, note: '' };
    }
    return { value: v, confidence: 0.45, note: 'Yeh number nahi lag raha — dobara bataiye?' };
  }

  if (field.type === 'date' || key === 'date_of_birth') {
    const iso = parseDateLoose(v);
    if (iso) return { value: iso, confidence: 0.9, note: '' };
    return { value: v, confidence: 0.4, note: 'Date samajh nahi aayi, DD/MM/YYYY mein bataiye.' };
  }

  if (field.type === 'phone' || key === 'mobile') {
    const d = v.replace(/\D/g, '').replace(/^91/, '');
    if (d.length === 10) return { value: d, confidence: 0.95, note: '' };
    return { value: d || v, confidence: 0.5, note: '10 digit ka number chahiye.' };
  }

  if (key === 'aadhaar') {
    const d = v.replace(/\D/g, '');
    if (d.length === 12) return { value: d, confidence: 0.93, note: '' };
    return { value: d || v, confidence: 0.55, note: 'Aadhaar 12 digit ka hota hai.' };
  }

  if (key === 'ifsc') {
    const up = v.replace(/\s/g, '').toUpperCase();
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(up)) return { value: up, confidence: 0.92, note: '' };
    return { value: up, confidence: 0.55, note: 'IFSC 11 characters: 4 letters, 0, 6 characters.' };
  }

  if (field.type === 'email') {
    return { value: v.toLowerCase(), confidence: /^\S+@\S+\.\S+$/.test(v) ? 0.93 : 0.5, note: '' };
  }

  // free text
  return { value: v, confidence: v.length > 1 ? 0.9 : 0.5, note: '' };
}

/** "pachas hazaar" / "50 hazaar" / "do lakh" → number */
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
        reason: `Income "${income}" figures mein nahi hai. Instruction 2 kehta hai sirf numbers likhein, words nahi.`,
        suggestedValue: String(estimateIncome(income) ?? ''),
        rule: 'Instruction 2: income in figures only',
      });
    } else if (Number.isFinite(numeric) && numeric > 0 && numeric < 30000) {
      verdicts.push({
        fieldId: 'annual_family_income',
        status: 'fix',
        reason: `Income ${numeric} likhi hai. Scheme ki limit ₹2,50,000 saalana hai, isliye yeh mahine ki income lag rahi hai. Poore saal ki income likhiye — jaise ${numeric * 12}.`,
        suggestedValue: String(numeric * 12),
        rule: 'Instruction 1 + 2: annual income, limit Rs 2,50,000',
      });
    } else if (numeric > 250000) {
      verdicts.push({
        fieldId: 'annual_family_income',
        status: 'warn',
        reason: `₹${numeric.toLocaleString('en-IN')} income scheme ki ₹2,50,000 limit se zyada hai. Yahan form reject ho sakta hai — income certificate se milaan kar lijiye.`,
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
          reason: 'Mobile mein space ya hyphen hai — hata dijiye, sirf 10 digit rakhein.',
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
        reason: 'Mobile mein space ya hyphen hai — hata dijiye.',
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
        reason: `${pct}% possible nahi hai. Marksheet dekh kar 0 se 100 ke beech likhein.`,
        rule: 'Instruction 7',
      });
    } else if (!/\.\d{2}$/.test(pct)) {
      verdicts.push({
        fieldId: 'percentage',
        status: 'warn',
        reason: 'Instruction 7 kehta hai do decimal tak likhein — jaise ' + n.toFixed(2) + '.',
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
        reason: 'Form DD/MM/YYYY maangta hai, aapke paas YYYY-MM-DD hai. Answer sheet par DD/MM/YYYY mein chhap jayega.',
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
        reason: `"${f.label}" khali hai aur yeh compulsory hai.`,
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
    ? `Instruction page nahi mila, isliye sirf format check kiya. ${fixes ? `${fixes} field theek karni hai.` : 'Format theek lag raha hai.'} Scheme ke rules ke liye instruction page bhi scan karein.`
    : fixes > 0
      ? `${fixes} field instruction se match nahi kar rahi${warns ? `, aur ${warns} par dhyan dena hai` : ''}. Neeche wale card par tap karke seedha theek kar lein — phir form reject nahi hoga.`
      : warns > 0
        ? `Sab compulsory fields bhar gaye hain. ${warns} field par ek nazar daal lein, baaki theek hai.`
        : `Badhai ho — ${okCount} fields official instructions se match kar rahi hain. Submit se pehle documents ki list dekh lein.`;


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
      ? `"${opts.formTitle}" ke saare compulsory fields bhar gaye hain.`
      : `"${opts.formTitle}" mein ${red} field abhi khali hai — wahi pehle bharna hoga.`,
  );
  if (yellow > 0) lines.push(`${yellow} field par ek nazar daal lein, format thoda off hai.`);
  lines.push(
    opts.hasInstructions
      ? 'Yeh check official instruction page se mila kar kiya gaya hai.'
      : 'Instruction page diya nahi tha, isliye abhi sirf format check hua hai.',
  );
  lines.push(`Total ${green + yellow + red} fields — copy karne ke liye answer sheet neeche hai.`);

  const nextSteps: string[] = [];
  if (red > 0) nextSteps.push(`${red} khali field bhariye.`);
  if (yellow > 0) nextSteps.push('Peeli light wale fields ka format theek kijiye.');
  nextSteps.push('Income certificate aur caste certificate saath rakhein — verification mein maange jayenge.');
  nextSteps.push('Form print karke signature karein, phir office mein jama karein.');

  return {
    summary: lines.join(' '),
    nextSteps,
    confidence: red > 0 ? 0.62 : yellow > 0 ? 0.8 : 0.92,
  };
}

/* ── Freeform chat (cloud) ────────────────────────────────────────────── */

const CHAT_ANSWERS: Array<[RegExp, string]> = [
  [/document|kagaz|certificate/i, 'Income certificate (tehsil se), caste certificate, bank passbook ka pehla page aur last marksheet — yeh chaar cheezein zaroori hain. Sab par aapka naam saaf dikhna chahiye.'],
  [/reject|mana|cancel/i, 'Reject hone ka sabse bada kaaran hota hai monthly vs annual income, ya mobile mein +91. Aap yahan dono check kar sakte hain — yellow light wale field par tap karein.'],
  [/last date|aakhri|deadline/i, 'Is form ki last date 31 January 2027 hai. Late application accept nahi hoti, isliye documents pehle hi ready rakhein.'],
  [/status|kab tak|paisa/i, 'Status SMS aapke mobile par aayega, kyunki form mein wahi number diya hai. Paise seedha bank account mein aate hain — account aapke hi naam par hona chahiye.'],
  [/offline|internet|net/i, 'Purana form bharna internet ke bina bhi ho jata hai — sab kuch aapke phone mein hi save rehta hai. Bas cloud check ke liye net chahiye, aur woh baad mein apne aap ho jayega.'],
];

export function mockChat(question: string): string {
  for (const [re, answer] of CHAT_ANSWERS) {
    if (re.test(question)) return answer;
  }
  return 'Is form ke liye: saare compulsory (*) fields bhar dein, income saalana figures mein likhein, aur mobile bina +91 ke. Koi specific field ho to uska naam bata dein, main wahi samjha deta hoon.';
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
