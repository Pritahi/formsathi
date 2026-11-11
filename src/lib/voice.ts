/**
 * Voice in/out. Both use the browser's own engines - no API keys, no cost.
 *
 *  Voice IN  : Web Speech API (SpeechRecognition). Chrome/Edge support it on
 *              Android and desktop; Safari supports it behind its own prefixed
 *              constructor; Firefox does not. When unavailable the mic button
 *              simply does not render - no broken button.
 *  Voice OUT : speechSynthesis with en-IN preferred, then hi-IN. Works nearly
 *              everywhere, and is what makes the interview usable for someone
 *              who reads slowly.
 *
 * The UI is in English by default. `en-IN` is the recognition language for
 * English dictation; we always pass the text as-is and let the engine decide.
 * If Indian English is missing we fall back to Hindi, then generic English -
 * still far friendlier than silence.
 */

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechResultEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  const g = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export const voiceInputSupported = (): boolean => !!getRecognitionCtor();

export interface ListenOptions {
  lang?: 'en-IN' | 'hi-IN';
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
}

export interface ListeningHandle {
  stop(): void;
}

/** Start dictation. Returns null when the API is unavailable. */
export function startListening(opts: ListenOptions): ListeningHandle | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    opts.onError?.('This browser has no voice input - type instead.');
    return null;
  }
  const rec = new Ctor();
  rec.lang = opts.lang ?? 'en-IN';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = '';

  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const res = ev.results[i]!;
      const alt = res[0];
      if (!alt) continue;
      if (res.isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (interim) opts.onInterim?.(interim);
    if (finalText) opts.onInterim?.(finalText);
  };

  rec.onerror = (ev) => {
    const map: Record<string, string> = {
      'not-allowed': 'Microphone permission not granted. Allow it in browser settings.',
      'no-speech': 'Nothing heard - speak again.',
      'audio-capture': 'No microphone found. Check once.',
      network: 'Voice needs internet. Type instead.',
      aborted: '',
    };
    const msg = map[ev.error] ?? `Voice error: ${ev.error}`;
    if (msg) opts.onError?.(msg);
  };

  rec.onend = () => {
    if (finalText.trim()) opts.onFinal(finalText.trim());
  };

  try {
    rec.start();
  } catch {
    opts.onError?.('Voice could not start. Try again.');
    return null;
  }

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}

/* ── Speech out ───────────────────────────────────────────────────────── */

let voicesCache: SpeechSynthesisVoice[] = [];
let preferredVoice: SpeechSynthesisVoice | null = null;
let speaking = false;

export const voiceOutputSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;

export function loadVoices(): void {
  if (!voiceOutputSupported()) return;
  voicesCache = window.speechSynthesis.getVoices();
  preferredVoice =
    voicesCache.find((v) => /^en[-_]IN/i.test(v.lang)) ??
    voicesCache.find((v) => /^hi[-_]IN/i.test(v.lang)) ??
    voicesCache.find((v) => /^hi/i.test(v.lang)) ??
    voicesCache.find((v) => /^en[-_]GB/i.test(v.lang)) ??
    voicesCache.find((v) => /^en/i.test(v.lang)) ??
    null;
}

if (voiceOutputSupported()) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  onEnd?: () => void;
  /** Skip if another utterance is in flight (default true). */
  interrupt?: boolean;
}

/** Speak an English line. Silent no-op when unsupported. */
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!voiceOutputSupported() || !text.trim()) {
    opts.onEnd?.();
    return;
  }
  const synth = window.speechSynthesis;
  if (synth.speaking && opts.interrupt !== false) synth.cancel();
  if (synth.speaking && opts.interrupt === false) return;

  const utter = new SpeechSynthesisUtterance(text);
  if (!preferredVoice) loadVoices();
  if (preferredVoice) utter.voice = preferredVoice;
  utter.lang = preferredVoice?.lang ?? 'en-IN';
  utter.rate = opts.rate ?? 0.95;
  utter.pitch = opts.pitch ?? 1;
  utter.onend = () => {
    speaking = false;
    opts.onEnd?.();
  };
  utter.onerror = () => {
    speaking = false;
    opts.onEnd?.();
  };
  speaking = true;
  synth.speak(utter);
}

export function stopSpeaking(): void {
  if (!voiceOutputSupported()) return;
  window.speechSynthesis.cancel();
  speaking = false;
}

export const isSpeaking = (): boolean => speaking;

/** Which voice we will actually use - shown in Settings → Diagnostics so the
 * demo can be honest about quality. */
export function activeVoiceLabel(): string {
  if (!voiceOutputSupported()) return 'No voice output';
  if (!preferredVoice) return 'Default system voice';
  return `${preferredVoice.name} (${preferredVoice.lang})`;
}

