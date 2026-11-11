/**
 * Capability probe: can this browser actually run Gemini Nano on-device?
 *
 * The honest answer for `firebasehybridai` web apps (verified in the Firebase
 * docs, Nov 2026):
 *   • On-device web inference = Chrome's built-in Prompt API.
 *   • It exists in **desktop Chrome 139+**, with the model downloaded.
 *   • It does NOT exist on iOS Safari, Firefox, Samsung Internet, or any
 *     Chromium on Android (Android needs a native app + a Nano-supported
 *     device).
 *
 * The app never pretends otherwise. When the probe says no, personal answers use local rules
 * and only synthetic sample extraction may use cloud; the router log records the reason. That
 * honesty is a design requirement from the brief's red-team round, not a
 * limitation to hide.
 */

export type DeviceSupport =
  | 'available' // Nano is installed and ready
  | 'downloadable' // Prompt API present, model can be downloaded
  | 'downloading'
  | 'unavailable' // API present but model can never be used here
  | 'unsupported'; // no Prompt API at all

export interface CapabilityReport {
  support: DeviceSupport;
  /** One-line Hinglish reason for the UI and the router log. */
  reason: string;
  /** Structured details for the Settings → Diagnostics panel. */
  detail: {
    hasPromptApi: boolean;
    isDesktop: boolean;
    chromiumMajor: number | null;
    browser: string;
    secureContext: boolean;
    online: boolean;
  };
}

interface LanguageModelLike {
  availability?: (opts?: unknown) => Promise<string>;
  capabilities?: () => Promise<{ available?: string }>;
  create?: (opts?: unknown) => Promise<unknown>;
}

function getLanguageModel(): LanguageModelLike | null {
  const g = globalThis as unknown as {
    LanguageModel?: LanguageModelLike;
    ai?: { languageModel?: LanguageModelLike };
  };
  return g.LanguageModel ?? g.ai?.languageModel ?? null;
}

/** Chromium major version from the UA. Empty on other engines. */
export function chromiumMajor(ua = navigator.userAgent): number | null {
  const m = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function browserName(ua = navigator.userAgent): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

export function isDesktopLike(ua = navigator.userAgent): boolean {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  // iPadOS 13+ masquerades as macOS; touch points give it away.
  const iPadDesktopMode =
    /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  return !mobile && !iPadDesktopMode;
}

/**
 * Probe the device. Cheap: `availability()` does not download anything.
 * Wrapped in a timeout because a wedged API must never block the whole app.
 */
export async function probeOnDevice(timeoutMs = 2500): Promise<CapabilityReport> {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const detail = {
    hasPromptApi: false,
    isDesktop: isDesktopLike(ua),
    chromiumMajor: chromiumMajor(ua),
    browser: browserName(ua),
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  };

  const lm = getLanguageModel();
  detail.hasPromptApi = !!lm;

  if (!lm) {
    return {
      support: 'unsupported',
      reason: `${detail.browser} does not have the on-device model API - personal answers stay local; only synthetic samples may use the cloud.`,
      detail,
    };
  }

  if (!detail.secureContext) {
    return {
      support: 'unsupported',
      reason: 'On-device inference needs HTTPS. Personal answers stay local; only synthetic samples may use cloud.',
      detail,
      };
  }

  let raw: string | undefined;
  try {
    const probe = (async () => {
      if (lm.availability) {
        const a = await lm.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
        return typeof a === 'string' ? a : 'unavailable';
      }
      if (lm.capabilities) {
        const c = await lm.capabilities();
        return c.available ?? 'unavailable';
      }
      return 'downloadable';
    })();
    raw = await Promise.race([
      probe,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
  } catch {
    raw = 'unavailable';
  }

  const normalized = String(raw ?? '').toLowerCase();
  if (normalized === 'timeout') {
    return {
      support: 'unavailable',
      reason: 'The on-device model did not respond. Personal answers stay local.',
      detail,
    };
  }

  // Chrome reports "available" | "downloadable" | "downloading" | "unavailable".
  if (normalized.includes('available') && !normalized.includes('unavailable')) {
    return { support: 'available', reason: 'Gemini Nano is ready on this device.', detail };
  }
  if (normalized.includes('downloadable')) {
    return {
      support: 'downloadable',
      reason: 'Gemini Nano can be downloaded. Use Download Nano in Settings on an unmetered connection.',
      detail,
    };
  }
  if (normalized.includes('downloading')) {
    return {
      support: 'downloading',
      reason: 'Gemini Nano is downloading. On-device inference will be ready when it finishes.',
      detail,
    };
  }
  return {
    support: 'unavailable',
    reason: detail.isDesktop
      ? 'Gemini Nano is not available on this device - personal answers stay local; only synthetic samples may use the cloud.'
      : 'On-device model is not supported on mobile browsers - personal answers stay local; only synthetic samples may use the cloud.',
    detail,
  };
}

/** True when the on-device path is genuinely usable right now. */
export function canUseOnDevice(report: CapabilityReport): boolean {
  return report.support === 'available';
}

/** Hinglish label for the UI badge. */
export function deviceSupportLabel(support: DeviceSupport): string {
  switch (support) {
    case 'available':
      return 'On-device ready';
    case 'downloadable':
      return 'On-device available (download)';
    case 'downloading':
      return 'Downloading model';
    case 'unavailable':
      return 'Nano unavailable; personal answers local';
    default:
      return 'Nano unsupported; personal answers local';
  }
}
