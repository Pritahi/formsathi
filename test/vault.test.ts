/**
 * Vault crypto + cross-form matching tests.
 *
 * Runs in Node using the WebCrypto globals Node 20 provides, which is the same
 * spec surface the browser uses (AES-GCM, PBKDF2). The IndexedDB half is not
 * exercised here — that is covered by the browser smoke test in
 * test/e2e_flow.py, which drives a real Chromium.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveKeyFromPassphrase,
  fromB64,
  generateVaultKey,
  makeVerifier,
  open,
  randomBytes,
  seal,
  toB64,
  verifyKey,
} from '../src/vault/crypto';
import { canonicalKeyFor, isSensitiveField } from '../src/vault/vault';

describe('vault crypto', () => {
  it('round-trips a record', async () => {
    const key = await generateVaultKey();
    const sealed = await seal(key, 'Priya Kumari', 'full_name|normal');
    expect(sealed.ciphertext).not.toContain('Priya');
    await expect(open(key, sealed, 'full_name|normal')).resolves.toBe('Priya Kumari');
  });

  it('uses a fresh IV for every record', async () => {
    const key = await generateVaultKey();
    const a = await seal(key, 'same plaintext', 'k');
    const b = await seal(key, 'same plaintext', 'k');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a record whose sensitivity tag was swapped', async () => {
    const key = await generateVaultKey();
    const sealed = await seal(key, '9876543210', 'mobile|normal');
    // An attacker flipping normal → sensitive must break authentication.
    await expect(open(key, sealed, 'mobile|sensitive')).rejects.toThrow();
  });

  it('refuses a different key', async () => {
    const k1 = await generateVaultKey();
    const k2 = await generateVaultKey();
    const sealed = await seal(k1, 'secret', 'x');
    await expect(open(k2, sealed, 'x')).rejects.toThrow();
  });

  it('verifies the right passphrase and rejects a wrong one', async () => {
    const salt = randomBytes(16);
    const key = await deriveKeyFromPassphrase('mera-password-123', salt);
    const verifier = await makeVerifier(key);
    await expect(verifyKey(key, verifier)).resolves.toBe(true);

    const wrong = await deriveKeyFromPassphrase('galat-password', salt);
    await expect(verifyKey(wrong, verifier)).resolves.toBe(false);
  });

  it('base64 helpers survive binary', () => {
    const bytes = randomBytes(32);
    expect(Array.from(fromB64(toB64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('cross-form matching', () => {
  it('maps the many ways Indian forms say "name" to one key', () => {
    expect(canonicalKeyFor('Name of Applicant (as per matric certificate)')).toBe('full_name');
    expect(canonicalKeyFor("Applicant's Full Name")).toBe('full_name');
    expect(canonicalKeyFor('Name of the Candidate')).toBe('full_name');
  });

  it('maps fathers and mothers separately — never confuses them', () => {
    expect(canonicalKeyFor("Father's Name")).toBe('father_name');
    expect(canonicalKeyFor("Mother's Name")).toBe('mother_name');
  });

  it('maps the identity fields the vault reuses across forms', () => {
    expect(canonicalKeyFor('Aadhaar Number (12 digits)')).toBe('aadhaar');
    expect(canonicalKeyFor('Mobile Number (10 digits)')).toBe('mobile');
    expect(canonicalKeyFor('Date of Birth (DD/MM/YYYY)')).toBe('date_of_birth');
    expect(canonicalKeyFor('PIN Code (6 digits)')).toBe('pincode');
    expect(canonicalKeyFor('Annual Family Income (in rupees)')).toBe('annual_family_income');
  });

  it('flags identity fields as sensitive for the vault UI', () => {
    expect(isSensitiveField('Aadhaar Number')).toBe(true);
    expect(isSensitiveField('Bank Account Number')).toBe(true);
    expect(isSensitiveField('Annual Family Income')).toBe(true);
    expect(isSensitiveField('Course / Class')).toBe(false);
  });
});
