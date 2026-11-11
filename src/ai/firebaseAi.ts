import { ensureAppCheck } from '../services/appCheck';
/** Firebase AI Logic execution boundary.
 * Bundled synthetic samples may use PREFER_ON_DEVICE with cloud fallback.
 * Personal content always uses ONLY_ON_DEVICE and never retries in cloud.
 * App Check is initialized before the AI service. Source badges use the
 * response inferenceSource rather than a capability guess.
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
  prefer: 'on-device' | 'cloud' | 'hybrid';
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
let hybridModel: import('firebase/ai').GenerativeModel | null = null;
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
      ensureAppCheck(firebaseApp);
    const aiInstance = ai.getAI(firebaseApp, { backend: new ai.GoogleAIBackend() });

    const onDeviceParams = {
      createOptions: {
        expectedInputs: [{ type: 'text' as const, languages: ['en'] }, { type: 'image' as const }],
        expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
      },
    };
    // Personal content: SDK-enforced no-cloud boundary.
    genModel = ai.getGenerativeModel(aiInstance, {
      mode: ai.InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams,
    });
    // Genuine hybrid inference, restricted by callModel to synthetic samples.
    hybridModel = ai.getGenerativeModel(aiInstance, {
      mode: ai.InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: {
        model: CLOUD_MODEL,
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      },
      onDeviceParams,
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
 * (Chrome requirement) - the Settings screen's "Download Gemini Nano" button
 * does exactly that.
 */
export async function initializeDeviceModel(onProgress?: DeviceInitProgress): Promise<void> {
  if (!genModel) throw new Error('AI not initialised');
  if (deviceInitialized) {
    onProgress?.(1, 'Already ready');
    return;
  }
  await genModel.initializeDeviceModel((p) => onProgress?.(p));
  await hybridModel!.initializeDeviceModel((p) => onProgress?.(p));
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
    return await lm.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
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
  if ((opts.prefer === 'cloud' || opts.prefer === 'hybrid') && (!opts.syntheticOnly || typeof sessionStorage === 'undefined' || sessionStorage.getItem('formsathi-cloud-eligible') !== 'yes')) {
    throw new Error('Privacy guard: personal or free-form content cannot use unpaid cloud inference. Use the local workflow or synthetic samples.');
  }
  await initAi(config);
  const started = performance.now();

  const model = opts.prefer === 'cloud' ? cloudModel! : opts.prefer === 'hybrid' ? hybridModel! : genModel!;
  const parts = buildParts(opts);

  // Per-call generation config. On-device honours responseMimeType; cloud also
  // accepts a schema. We set both and let the SDK route.
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.4,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  if (opts.json && opts.schema && opts.prefer !== 'on-device') {
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
  if (opts.prefer === 'on-device' && source !== 'on_device') throw new Error('Privacy guard: device-only inference did not report an on-device source.');
  const text = response.text();
  const latencyMs = Math.round(performance.now() - started);

  return {
    text,
    path: source === 'on_device' ? 'on-device' : 'cloud',
    model: source === 'on_device' ? 'gemini-nano (Chrome built-in)' : CLOUD_REASONING_MODEL,
    latencyMs,
    fellBack: opts.prefer === 'hybrid' && source !== 'on_device',
  };
}

/** True when the SDK's hybrid adapter exists at all in this browser. */
export function hybridAdapterPresent(): boolean {
  const g = globalThis as unknown as { LanguageModel?: unknown; ai?: { languageModel?: unknown } };
  return !!(g.LanguageModel || g.ai?.languageModel);
}
