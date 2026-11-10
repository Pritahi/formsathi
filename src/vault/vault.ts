/**
 * The Answer Vault — encrypted, on-device, reusable answers.
 *
 * Product rule that the whole hybrid story rests on:
 *   PERSONAL ANSWERS NEVER GO TO FIRESTORE.
 * This module is therefore the only place answer values are written, and it
 * only ever writes ciphertext into IndexedDB. Nothing here imports Firebase.
 *
 * Matching across forms: a second form's field is pre-filled when its label
 * normalizes to a key already in the vault (plus an alias table for the
 * different ways Indian forms say the same thing: "Name of the Applicant",
 * "Applicant ka naam", "Candidate's Full Name" …). This is what makes the
 * "80% instant" claim in the demo real rather than scripted.
 */

import { idb, kv, STORE } from '../lib/idb';
import { uniqueId } from '../lib/util';
import {
  deriveKeyFromPassphrase,
  fromB64,
  generateVaultKey,
  hasWebCrypto,
  makeVerifier,
  open as cryptoOpen,
  randomBytes,
  seal as cryptoSeal,
  toB64,
  verifyKey,
  type VaultMode,
  type VaultVerifier,
} from './crypto';

/** A decrypted answer record. */
export interface VaultRecord {
  /** Canonical key (slug) — the id used for cross-form matching. */
  id: string;
  /** Human label of the field this came from, for the vault screen. */
  label: string;
  value: string;
  /** Sensitivity drives cloud redaction and whether we ever echo it in logs. */
  sensitive: boolean;
  updatedAt: number;
  /** How many distinct forms this answer has filled. Shown as "reused 3×". */
  uses: number;
}

/** What actually sits in IndexedDB: ciphertext + non-secret metadata. */
interface SealedVaultRecord {
  id: string;
  /** ciphertext of JSON({label,value}) */
  ciphertext: string;
  iv: string;
  sensitive: boolean;
  updatedAt: number;
  uses: number;
}

interface VaultMeta {
  version: 1;
  mode: VaultMode;
  createdAt: number;
  /** Only present in passphrase mode (quick mode stores a CryptoKey object). */
  saltB64?: string;
  verifier: VaultVerifier;
  recordCount: number;
}

const META_KEY = 'vault_meta';
const KEY_OBJ_KEY = 'vault_key_quick';

/** Sensitivity keywords. Kept here (not in config) because the vault owns the
 *  classification that the redactor trusts. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /aadha?ar/i,
  /\bpan\b/i,
  /bank/i,
  /account\s*(no|number)/i,
  /ifsc/i,
  /mobile|phone|contact/i,
  /email/i,
  /dob|date\s*of\s*birth|birth/i,
  /address|pata|pin\s*code|pincode/i,
  /caste|category|certificate/i,
  /income/i,
  /disabilit|divyang/i,
  /family\s*id/i,
  /passport/i,
  /voter/i,
  /ration/i,
];

/**
 * Matching a form label to a canonical vault key.
 *
 * This is an ORDERED keyword classifier rather than a pile of anchored regexes,
 * because real Indian forms are inconsistent in ways regexes lose to:
 *   "Name of Applicant (as per matric certificate)"
 *   "Applicant's Full Name"        "Candidate Name"
 *   "Father's Name"  vs  "Pita ka naam"
 *
 * Order matters and is load-bearing:
 *   • father/mother BEFORE the generic name rule, or dad's name overwrites the
 *     applicant's.
 *   • institution/nominee BEFORE the generic name rule for the same reason.
 *   • "date of birth" BEFORE any generic date handling.
 *
 * A wrong match writes one person's data into another person's field, which is
 * the single worst failure this app can have — so the classifier is deliberately
 * narrow: when nothing matches confidently it returns a slug and the vault does
 * NOT pre-fill that field.
 */
function matchLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[’'`]/g, ' ') // father's -> father s
    .replace(/\(.*?\)/g, ' ') // drop "(in figures only)" and bilingual glosses
    .replace(/[\u0900-\u097F]+/g, ' ') // Devanagari half of a bilingual label
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface AliasRule {
  key: string;
  test: (n: string) => boolean;
}

const hasAny = (n: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(n));

const ALIAS_RULES: AliasRule[] = [
  // ── identity numbers first: they must never be confused with anything ──
  { key: 'aadhaar', test: (n) => /aadha|aadhar|adhar|uid\s*ai/.test(n) },
  { key: 'pan', test: (n) => /\bpan\b|permanent account number/.test(n) },
  { key: 'ifsc', test: (n) => /ifsc/.test(n) },
  {
    key: 'bank_account',
    test: (n) => hasAny(n, 'account', 'ac', 'a\/c') && hasAny(n, 'bank', 'account', 'no', 'number'),
  },
  { key: 'email', test: (n) => /\bemail\b|e mail/.test(n) },
  { key: 'mobile', test: (n) => hasAny(n, 'mobile', 'phone', 'contact') },
  { key: 'pincode', test: (n) => hasAny(n, 'pincode', 'pin', 'postal') && hasAny(n, 'code', 'code', 'pincode', 'pin') },
  { key: 'date_of_birth', test: (n) => /date of birth|birth date|\bdob\b|janm|born/.test(n) },

  // ── people: specific relations before the generic "name" ───────────────
  { key: 'father_name', test: (n) => hasAny(n, 'father', 'pita', 'guardian') },
  { key: 'mother_name', test: (n) => hasAny(n, 'mother', 'mata', 'ma') && hasAny(n, 'name', 'mother', 'mata') },
  { key: 'nominee_name', test: (n) => hasAny(n, 'nominee', 'nomination') },
  { key: 'institution_name', test: (n) => hasAny(n, 'school', 'college', 'institution', 'university', 'institute') },
  { key: 'full_name', test: (n) => /\bname\b/.test(n) },

  // ── everything else ───────────────────────────────────────────────────
  { key: 'address', test: (n) => hasAny(n, 'address', 'pata') },
  { key: 'annual_family_income', test: (n) => hasAny(n, 'income') },
  { key: 'category', test: (n) => hasAny(n, 'category', 'caste') },
  { key: 'gender', test: (n) => hasAny(n, 'gender', 'sex') },
  { key: 'occupation', test: (n) => hasAny(n, 'occupation', 'profession') },
  { key: 'course', test: (n) => hasAny(n, 'course', 'class', 'standard', 'stream', 'semester') },
  { key: 'roll_number', test: (n) => hasAny(n, 'roll', 'registration') },
  { key: 'district', test: (n) => hasAny(n, 'district', 'zila') },
  { key: 'state', test: (n) => hasAny(n, 'state', 'rajya') },
  { key: 'nationality', test: (n) => hasAny(n, 'nationality', 'citizen') },
  { key: 'percentage', test: (n) => hasAny(n, 'percentage', 'marks', 'percent') },
  { key: 'signature', test: (n) => hasAny(n, 'signature', 'sign') && !hasAny(n, 'official') },
];

/** Map a form label to a canonical vault key. */
export function canonicalKeyFor(label: string): string {
  const n = matchLabel(label);
  for (const rule of ALIAS_RULES) {
    if (rule.test(n)) return rule.key;
  }
  return n.replace(/\s+/g, '_') || 'field';
}

/**
 * Exported for the UI: does the vault consider these two labels the same thing?
 * Used by the checklist to explain why a field was pre-filled.
 */
export function labelsMatch(a: string, b: string): boolean {
  return canonicalKeyFor(a) === canonicalKeyFor(b);
}

export function isSensitiveField(label: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(label));
}

/** In-memory unlocked key. Cleared by lock(). Never persisted in plaintext. */
let vaultKey: CryptoKey | null = null;

export const vaultState = {
  get unlocked(): boolean {
    return vaultKey !== null;
  },
  supportsCrypto: hasWebCrypto(),
};

/* ── lifecycle ─────────────────────────────────────────────────────────── */

export async function vaultExists(): Promise<boolean> {
  const meta = await kv.get<VaultMeta>(META_KEY);
  return !!meta;
}

export async function getVaultMeta(): Promise<VaultMeta | null> {
  return (await kv.get<VaultMeta>(META_KEY)) ?? null;
}

/**
 * Create a new vault.
 *  - mode 'passphrase': PBKDF2-derived key; user must re-enter on unlock.
 *  - mode 'quick': random key stored as a non-extractable CryptoKey in IDB;
 *    unlocks automatically on this device. Convenient for a demo on a borrowed
 *    laptop; the passphrase mode is what the README recommends for real use.
 */
export async function createVault(
  opts: { mode: VaultMode; passphrase?: string },
): Promise<void> {
  if (!hasWebCrypto()) throw new Error('Is browser mein WebCrypto nahi hai (HTTPS chahiye).');
  if (opts.mode === 'passphrase') {
    const pw = (opts.passphrase ?? '').trim();
    if (pw.length < 6) throw new Error('Passphrase kam se kam 6 characters ki rakhein.');
    const salt = randomBytes(16);
    const key = await deriveKeyFromPassphrase(pw, salt);
    const verifier = await makeVerifier(key);
    vaultKey = key;
    const meta: VaultMeta = {
      version: 1,
      mode: 'passphrase',
      createdAt: Date.now(),
      saltB64: toB64(salt),
      verifier,
      recordCount: 0,
    };
    await kv.set(META_KEY, meta);
    return;
  }

  const key = await generateVaultKey();
  const verifier = await makeVerifier(key);
  vaultKey = key;
  // CryptoKey is structured-cloneable; the raw bytes stay unreachable to JS.
  await idb.put(STORE.kv, key, KEY_OBJ_KEY);
  const meta: VaultMeta = {
    version: 1,
    mode: 'quick',
    createdAt: Date.now(),
    verifier,
    recordCount: 0,
  };
  await kv.set(META_KEY, meta);
}

/** Unlock with a passphrase (no-op in quick mode, which auto-unlocks). */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const meta = await getVaultMeta();
  if (!meta) return false;
  if (meta.mode === 'quick') return unlockQuick();
  if (!meta.saltB64) return false;
  const key = await deriveKeyFromPassphrase(passphrase, fromB64(meta.saltB64));
  const ok = await verifyKey(key, meta.verifier);
  if (ok) vaultKey = key;
  return ok;
}

/** Quick mode: pull the stored CryptoKey object back out of IndexedDB. */
export async function unlockQuick(): Promise<boolean> {
  const meta = await getVaultMeta();
  if (!meta) return false;
  if (vaultKey) return true;
  if (meta.mode === 'quick') {
    const key = await idb.get<CryptoKey>(STORE.kv, KEY_OBJ_KEY);
    if (!key) return false;
    vaultKey = key;
    return true;
  }
  return false;
}

/** Try to unlock silently (quick mode only). Used on boot. */
export async function trySilentUnlock(): Promise<boolean> {
  const meta = await getVaultMeta();
  if (!meta) return false;
  if (meta.mode !== 'quick') return false;
  return unlockQuick();
}

export function lockVault(): void {
  vaultKey = null;
}

/**
 * Destroy the vault: wipes encrypted records, key and meta.
 * Photo blobs and sessions are separate — the Settings screen asks separately.
 */
export async function destroyVault(): Promise<void> {
  vaultKey = null;
  const ids = await idb.keys(STORE.vault);
  for (const id of ids) await idb.del(STORE.vault, id);
  await kv.del(KEY_OBJ_KEY);
  await kv.del(META_KEY);
}

/* ── read / write ──────────────────────────────────────────────────────── */

function requireKey(): CryptoKey {
  if (!vaultKey) throw new Error('Vault locked hai — pehle unlock karein.');
  return vaultKey;
}

const AD = (id: string, sensitive: boolean) => `${id}|${sensitive ? 'sensitive' : 'normal'}`;

export async function putAnswer(input: {
  id?: string;
  label: string;
  value: string;
  sensitive?: boolean;
}): Promise<VaultRecord> {
  const key = requireKey();
  const meta = await getVaultMeta();
  if (!meta) throw new Error('Vault meta missing');

  const id = input.id ?? canonicalKeyFor(input.label);
  const sensitive = input.sensitive ?? isSensitiveField(input.label);
  const body = JSON.stringify({ label: input.label, value: input.value });
  const sealed = await cryptoSeal(key, body, AD(id, sensitive));

  const existing = await idb.get<SealedVaultRecord>(STORE.vault, id);
  const rec: SealedVaultRecord = {
    id,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    sensitive,
    updatedAt: Date.now(),
    uses: existing?.uses ?? 0,
  };
  await idb.put(STORE.vault, rec);
  if (!existing) {
    await kv.set(META_KEY, { ...meta, recordCount: meta.recordCount + 1 });
  }
  return { id, label: input.label, value: input.value, sensitive, updatedAt: rec.updatedAt, uses: rec.uses };
}

export async function getAnswer(id: string): Promise<VaultRecord | null> {
  const key = requireKey();
  const rec = await idb.get<SealedVaultRecord>(STORE.vault, id);
  if (!rec) return null;
  try {
    const body = JSON.parse(await cryptoOpen(key, rec, AD(rec.id, rec.sensitive))) as {
      label: string;
      value: string;
    };
    return {
      id: rec.id,
      label: body.label,
      value: body.value,
      sensitive: rec.sensitive,
      updatedAt: rec.updatedAt,
      uses: rec.uses,
    };
  } catch {
    // Wrong key or tampered record — treat as absent rather than crash.
    return null;
  }
}

export async function getAllAnswers(): Promise<VaultRecord[]> {
  if (!vaultKey) return [];
  const sealed = await idb.all<SealedVaultRecord>(STORE.vault);
  const out: VaultRecord[] = [];
  for (const rec of sealed) {
    const r = await getAnswer(rec.id);
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export async function deleteAnswer(id: string): Promise<void> {
  const meta = await getVaultMeta();
  await idb.del(STORE.vault, id);
  if (meta) await kv.set(META_KEY, { ...meta, recordCount: Math.max(0, meta.recordCount - 1) });
}

export async function bumpUses(ids: string[]): Promise<void> {
  for (const id of ids) {
    const rec = await idb.get<SealedVaultRecord>(STORE.vault, id);
    if (rec) await idb.put(STORE.vault, { ...rec, uses: rec.uses + 1 });
  }
}

/** How many distinct fields in this list the vault can already answer. */
export function matchFieldsToVault(
  fields: Array<{ id: string; label: string }>,
  records: VaultRecord[],
): Array<{ fieldId: string; record: VaultRecord }> {
  const byKey = new Map<string, VaultRecord>();
  for (const r of records) byKey.set(r.id, r);
  const out: Array<{ fieldId: string; record: VaultRecord }> = [];
  const taken = new Set<string>();
  for (const f of fields) {
    const key = canonicalKeyFor(f.label);
    const rec = byKey.get(key) ?? byKey.get(uniqueId(key, new Set()));
    if (rec && !taken.has(rec.id)) {
      out.push({ fieldId: f.id, record: rec });
      taken.add(rec.id);
    }
  }
  return out;
}

/** Convenience: the keys the interview should skip. */
export async function prefillFor(
  fields: Array<{ id: string; label: string }>,
): Promise<Record<string, VaultRecord>> {
  if (!vaultKey) return {};
  const records = await getAllAnswers();
  const matches = matchFieldsToVault(fields, records);
  const map: Record<string, VaultRecord> = {};
  for (const m of matches) map[m.fieldId] = m.record;
  return map;
}
