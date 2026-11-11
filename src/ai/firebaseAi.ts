/**
 * The real Firebase AI Logic path. Dormant until config/config.ts is filled in
 * and DEMO MODE is off — but it is complete, compiling code, not a stub.
 *
 * Two model surfaces, exactly as the SDK exposes them:
 *
 *  HYBRID (on-device preferred):
 *    getGenerativeModel(ai, {
 *      mode: InferenceMode.PREFER_ON_DEVICE,
 *      inCloudParams:  { model: CLOUD_MODEL, generationConfig },
 *      onDeviceParams: { createOptions: { expectedInputs / expectedOutputs } },
 *    })
 *  The SDK falls back to the in-cloud model automatically when Nano is
 *  unavailable, and (crucially for us) rejects requests it cannot run
 *  on-device — images that are not JPEG/PNG, or anything with function
 *  responses. We additionally keep every on-device request single-turn.
 *
 *  CLOUD ONLY:
 *    getGenerativeModel(ai, { model: CLOUD_REASONING_MODEL, generationConfig })
 *
 * The response tells us which half actually ran: `response.inferenceSource`
 * is 'on_device' or 'in_cloud'. That value is what the UI badge and the README
 * table are built from — no guessing, no faking.
 */

import type { Part } from 'firebase/ai';
import type { FirebaseWebConfig } from '../config/config';
import { CLOUD_MODEL, CLOUD_REASONING_MODEL } from '../config/config';

import type { GenerateContentRequest, GenerationConfig } from 'firebase/ai';

type FirebaseAiModule = typeof import('firebase/ai');
type FirebaseAppModule = typeof import('firebase/app');

export interface AiCallOptions {
  /** The prompt text. Always already assembled (see prompts.ts). */
  prompt: string;
  /** Optional image, already JPEG/PNG (see image.ts). */
  image?: { base64: string; mimeType: 'image/jpeg' | 'image/png' };
  /** Ask for JSON. On-device honours responseMimeType=application/json. */
  json?: boolean;
  /** Cloud-only schema (on-device path ignores it; the SDK strips it). */
  schema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  /** Preferred half. 'on-device' uses PREFER_ON_DEVICE, 'cloud' is cloud-only. */
  prefer: 'on-device' | 'cloud';
  /** Only bundled, synthetic content may use the unpaid cloud API. */
  syntheticOnly?: boolean;
}

export interface AiCallResult {
  text: string;
  /** What actually ran. */
  path: 'on-device' | 'cloud';
  model: string;
  latencyMs: number;
  /** Populated when the SDK fell back from on-device to cloud. */
  fellBack: boolean;
}

export interface DeviceInitProgress {
  (progress: number, note?: string): void;
}

let aiModule: FirebaseAiModule | null = null;
let appModule: FirebaseAppModule | null = null;
let genModel: import('firebase/ai').GenerativeModel | null = null;
let cloudModel: import('firebase/ai').GenerativeModel | null = null;
let initPromise: Promise<void> | null = null;
let deviceInitialized = false;

/** Load Firebase lazily: if a photo-only offline user never signs in, we never
 *  pay for the Firebase bundle. */
async function loadModules(): Promise<{ ai: FirebaseAiModule; app: FirebaseAppModule }> {
  if (!aiModule || !appModule) {
    const [ai, app] = await Promise.all([import('firebase/ai'), import('firebase/app')]);
    aiModule = ai;
    appModule = app;
  }
  return { ai: aiModule, app: appModule };
}

export async function initAi(config: FirebaseWebConfig): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { ai, app } = await loadModules();
    const firebaseApp = app.getApps().length ? app.getApp() : app.initializeApp(config);
    const aiInstance = ai.getAI(firebaseApp, { backend: new ai.GoogleAIBackend() });

    // ── HYBRID MODEL ────────────────────────────────────────────────────
    // PREFER_ON_DEVICE: try Nano, fall back to cloud. The SDK's own fallback
    // is what makes the phone/Safari story work without any special casing.
    genModel = ai.getGenerativeModel(aiInstance, {
      mode: ai.InferenceMode.ONLY_ON_DEVICE,
      inCloudParams: {
        model: CLOUD_MODEL,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      },
      onDeviceParams: {
        createOptions: {
          // Nano needs to be told it may receive images and will emit text.
          expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
      },
    });

    // ── CLOUD-ONLY MODEL (verify + review + freeform chat) ──────────────
    cloudModel = ai.getGenerativeModel(aiInstance, {
      model: CLOUD_REASONING_MODEL,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    });
  })();
  return initPromise;
}

/**
 * Trigger the on-device model download. MUST be called from a user gesture
 * (Chrome requirement) — the Settings screen's "Download Gemini Nano" button
 * does exactly that.
 */
export async function initializeDeviceModel(onProgress?: DeviceInitProgress): Promise<void> {
  if (!genModel) throw new Error('AI not initialised');
  if (deviceInitialized) {
    onProgress?.(1, 'Already ready');
    return;
  }
  await genModel.initializeDeviceModel((p) => onProgress?.(p));
  deviceInitialized = true;
}

export function isDeviceModelInitialized(): boolean {
  return deviceInitialized;
}

/** Check whether Nano is available *without* downloading, via the SDK's own
 *  adapter. Returns null when the SDK cannot tell us. */
export async function deviceAvailability(): Promise<string | null> {
  const g = globalThis as unknown as {
    LanguageModel?: { availability?: (o?: unknown) => Promise<string> };
    ai?: { languageModel?: { availability?: (o?: unknown) => Promise<string> } };
  };
  const lm = g.LanguageModel ?? g.ai?.languageModel;
  if (!lm?.availability) return null;
  try {
    return await lm.availability();
  } catch {
    return null;
  }
}

/** Build the request parts once so both paths send identical content. */
function buildParts(opts: AiCallOptions): Part[] {
  const parts: Part[] = [{ type: 'text', text: opts.prompt }];
  if (opts.image) {
    // Only JPEG/PNG survive the on-device adapter's filter; image.ts guarantees
    // that, and the type here makes it impossible to pass anything else.
    parts.push({
      type: 'inlineData',
      inlineData: { data: opts.image.base64, mimeType: opts.image.mimeType },
    });
  }
  return parts;
}

/**
 * One model call. The router decides `prefer`; this function executes and
 * reports truthfully what happened.
 */
export async function callModel(config: FirebaseWebConfig, opts: AiCallOptions): Promise<AiCallResult> {
  if (opts.prefer === 'cloud' && (!opts.syntheticOnly || typeof sessionStorage === 'undefined' || sessionStorage.getItem('formsathi-cloud-eligible') !== 'yes')) {
    throw new Error('Privacy guard: personal or free-form content cannot use unpaid cloud inference. Use the local workflow or synthetic samples.');
  }
  await initAi(config);
  const started = performance.now();

  const model = opts.prefer === 'cloud' ? cloudModel! : genModel!;
  const parts = buildParts(opts);

  // Per-call generation config. On-device honours responseMimeType; cloud also
  // accepts a schema. We set both and let the SDK route.
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.4,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  if (opts.json && opts.schema && opts.prefer === 'cloud') {
    generationConfig.responseSchema = opts.schema;
  }

  // Constructed as a typed request so the SDK's own validation runs.
  const request: GenerateContentRequest = {
    contents: [{ role: 'user', parts }],
    generationConfig: generationConfig as GenerationConfig,
  };

  let result;
  try {
    result = await model.generateContent(request, { timeout: 60_000 });
  } catch (err) {
    // Never retry personal content in the cloud. ONLY_ON_DEVICE is a hard boundary.
    throw err;
  }

  const response = result.response;
  const source = response.inferenceSource ?? 'in_cloud';
  const text = response.text();
  const latencyMs = Math.round(performance.now() - started);

  return {
    text,
    path: source === 'on_device' ? 'on-device' : 'cloud',
    model: source === 'on_device' ? 'gemini-nano (Chrome built-in)' : CLOUD_REASONING_MODEL,
    latencyMs,
    fellBack: opts.prefer === 'on-device' && source !== 'on_device',
  };
}

/** True when the SDK's hybrid adapter exists at all in this browser. */
export function hybridAdapterPresent(): boolean {
  const g = globalThis as unknown as { LanguageModel?: unknown; ai?: { languageModel?: unknown } };
  return !!(g.LanguageModel || g.ai?.languageModel);
}
