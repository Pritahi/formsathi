/**
 * FormSathi configuration. Demo mode uses mock AI with a real local vault.
 * Live inference is not verified yet. Personal content is on-device-only;
 * only synthetic samples may use unpaid cloud inference after an eligibility gate.
 * Do not enable billing. New Firebase Storage setup requires Blaze and is unused.
 * See README for the current verified state and remaining provider/App Check setup.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

/** ── 1. PASTE YOUR WEB APP CONFIG HERE ─────────────────────────────────────
 *  Firebase console → Project settings → General → Your apps → SDK setup.
 *  While these contain the placeholder string "PASTE_", Firebase is disabled
 *  and the app runs fully local (vault + sessions in IndexedDB).            */
export const FIREBASE_CONFIG: FirebaseWebConfig = {
  apiKey: 'AIzaSyBWZB7YF_A6A7qcthliKKwVVFTSpgpMvfM',
  authDomain: 'studio-1586873794-46812.firebaseapp.com',
  projectId: 'studio-1586873794-46812',
  storageBucket: 'studio-1586873794-46812.firebasestorage.app',
  messagingSenderId: '291356683177',
  appId: '1:291356683177:web:899d9d8c7e44b8ca9132b8',
};

/** ── 2. DEMO MODE ─────────────────────────────────────────────────────────
 *  true  → every AI call resolves from src/ai/mock/ (realistic latency,
 *          realistic JSON, mock field extraction from the bundled sample
 *          forms, mock cloud-verify that catches the income-format error).
 *  false → Firebase AI Logic paths (provider and App Check setup required).
 *  The Settings sheet can override this at runtime (stored in localStorage)
 *  so a judge can flip to the live path without a rebuild.                  */
export const DEFAULT_DEMO_MODE = true;

/** ── 3. MODEL NAMES ───────────────────────────────────────────────────────
 *  On-device: Gemini Nano via Chrome's Prompt API (no model name needed; the
 *  browser owns the model). Cloud model names must be checked against current Firebase AI Logic docs.
 *  If your project has access to a different current Flash snapshot, change
 *  CLOUD_MODEL here only; every cloud call reads this constant.            */
export const CLOUD_MODEL = 'gemini-3.5-flash-lite';

/** Cloud model used for the heavier "verify + review" reasoning. On Spark the
 *  flash-lite tier keeps quota comfortable; swap for a Flash model if your
 *  AI Logic dashboard shows headroom. */
export const CLOUD_REASONING_MODEL = 'gemini-3.5-flash-lite';

/** ── 4. HYBRID BEHAVIOUR ──────────────────────────────────────────────────
 *  ON_DEVICE_PROBE: how long to wait for Nano availability before treating the
 *  device as cloud-only (ms). Nano's availability() is fast; the download is
 *  what is slow, and the download is explicitly user-triggered in Settings. */
export const ON_DEVICE_PROBE_TIMEOUT_MS = 2500;

/** After N total on-device model errors the router stops offering on-device
 *  for this session (still logged, still badged as cloud). */
export const ON_DEVICE_ERROR_BUDGET = 2;

/** ── 5. PRIVACY RAILS (do not weaken for the demo) ────────────────────────
 *  Field keys that are treated as sensitive-identity: their VALUES are never
 *  included in any cloud payload, never sent to Firestore, and never written
 *  to the console. Only their presence/format is checked in the cloud.     */
export const NEVER_SEND_VALUES_TO_CLOUD = [
  'aadhaar',
  'aadhar',
  'aadhaar_number',
  'pan',
  'pan_number',
  'bank_account',
  'ifsc',
  'mobile',
  'phone',
  'email',
  'dob',
  'date_of_birth',
  'address',
  'pin_code',
  'pincode',
  'caste_certificate_no',
];

/** Fields whose raw value also never lands in an on-device log line. */
export const REDACT_IN_LOGS = ['aadhaar', 'aadhar', 'pan', 'bank_account', 'mobile', 'phone'];

/** ── 6. IMAGE BUDGET (data-plan friendly) ─────────────────────────────────
 *  Form photos are re-encoded client-side before they leave the device, and
 *  always to image/jpeg (the only image type the on-device path accepts,
 *  together with image/png). Long edge in px and JPEG quality.             */
export const IMAGE_MAX_EDGE_PX = 1600;
export const IMAGE_JPEG_QUALITY = 0.8;
/** On-device gets a smaller image: Nano's vision is the slow half. */
export const IMAGE_MAX_EDGE_PX_ON_DEVICE = 1024;

/** ── 7. FEATURE FLAGS ─────────────────────────────────────────────────────
 *  Voice output (speech synthesis) and voice input (Web Speech API) are
 *  opportunistic: both fail silently into text. No external keys used.     */
export const FEATURES = {
  voiceInput: true,
  voiceOutput: true,
  pdfUpload: true,
  cloudVerify: true,
  syncMetadata: true,
  installPrompt: true,
} as const;

/** ── 8. FIRESTORE / STORAGE LOCATIONS ──────────────────────────────────── */
export const COL = {
  sessions: 'form_sessions',
  syncMeta: 'sync_meta',
} as const;

/** Storage prefix for form photos. Rules in firestore.rules + storage.rules
 *  restrict each path to its owner's uid. */
export const STORAGE_PREFIX = 'forms';

/**
 * True when the Firebase placeholders have not been replaced. Everything that
 * touches Firebase must check this through `isFirebaseConfigured()` in
 * lib/firebase.ts - the app degrades to local-only without throwing.
 */
export const FIREBASE_CONFIGURED: boolean = !Object.values(FIREBASE_CONFIG).some((v) =>
  String(v).includes('PASTE_'),
);

export const APP_VERSION = '1.0.0';
export const APP_NAME = 'FormSathi';
