/**
 * WebCrypto primitives for the Answer Vault.
 *
 * Design
 * ──────
 *  • One AES-GCM-256 key per vault ("the vault key").
 *  • Two ways to derive/obtain it:
 *      1. PASSPHRASE MODE - PBKDF2-SHA256, 310 000 iterations, 16-byte random
 *         salt. The derived key is imported as NON-EXTRACTABLE and lives only
 *         in memory. Nothing usable is written to disk except a verifier.
 *      2. QUICK MODE - a random AES key generated on this device, imported as
 *         non-extractable and stored as a CryptoKey object in IndexedDB (IDB
 *         can structured-clone CryptoKey; the raw bytes can never be read back
 *         by JavaScript, including ours).
 *  • Each answer is encrypted separately with a fresh 12-byte IV, so a single
 *    corrupted record cannot take the vault with it.
 *  • Sensitivity tag is authenticated as AES-GCM additionalData, so a record's
 *    plaintext cannot be re-labelled from "sensitive" to "normal".
 *
 * What this DOES protect against: another app or a stolen/lost device reading
 * the IndexedDB files; a browser extension that reads storage but cannot run
 * script in this origin; accidental Firestore leakage (nothing plaintext is
 * ever stored).
 * What this CANNOT protect against: malicious JavaScript running in this
 * origin while the vault is unlocked. That is stated plainly in the README and
 * in the app's vault screen - no over-claiming.
 */

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

export type VaultMode = 'passphrase' | 'quick';

export interface VaultVerifier {
  /** base64 of a known plaintext encrypted with the vault key. */
  ciphertext: string;
  iv: string;
}

const CHECK_PLAINTEXT = 'formsathi-vault-check-v1';

/* ── base64 helpers (no Buffer in the browser) ─────────────────────────── */

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/* ── key management ────────────────────────────────────────────────────── */

/** Derive a non-extractable AES-GCM key from a passphrase. */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: KEY_BITS },
    false, // non-extractable: JS can use it, never read it
    ['encrypt', 'decrypt'],
  );
}

/** Fresh random vault key (quick mode). */
export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BITS }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/* ── record encryption ─────────────────────────────────────────────────── */

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export async function seal(
  key: CryptoKey,
  plaintext: string,
  associatedData?: string,
): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: iv as unknown as BufferSource,
    tagLength: 128,
  };
  if (associatedData) params.additionalData = enc.encode(associatedData) as unknown as BufferSource;
  const ct = await crypto.subtle.encrypt(params, key, enc.encode(plaintext));
  return { ciphertext: toB64(ct), iv: toB64(iv) };
}

export async function open(
  key: CryptoKey,
  sealed: Sealed,
  associatedData?: string,
): Promise<string> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: fromB64(sealed.iv) as unknown as BufferSource,
    tagLength: 128,
  };
  if (associatedData) params.additionalData = enc.encode(associatedData) as unknown as BufferSource;
  const pt = await crypto.subtle.decrypt(params, key, fromB64(sealed.ciphertext) as unknown as BufferSource);
  return dec.decode(pt);
}

/* ── verifier: proves a candidate key is the vault key ─────────────────── */

export async function makeVerifier(key: CryptoKey): Promise<VaultVerifier> {
  // Associated data "check" domain-separates the canary from real records.
  const sealed = await seal(key, CHECK_PLAINTEXT, 'check');
  return sealed;
}

export async function verifyKey(key: CryptoKey, verifier: VaultVerifier): Promise<boolean> {
  try {
    const pt = await open(key, verifier, 'check');
    return pt === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Type guard for environments without subtle crypto (very old browsers,
 *  or non-secure origins where crypto.subtle is undefined). */
export function hasWebCrypto(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.encrypt === 'function';
}

export const VAULT_CRYPTO_PARAMS = {
  algorithm: 'AES-GCM',
  keyBits: KEY_BITS,
  kdf: 'PBKDF2-SHA256',
  iterations: PBKDF2_ITERATIONS,
  saltBytes: SALT_BYTES,
  ivBytes: IV_BYTES,
} as const;
