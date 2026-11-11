/** Small shared helpers. No dependencies, no side effects on import. */

let counter = 0;

export function uid(prefix = 'id'): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${rand}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export const nowMs = () => Date.now();

/** "Annual Family Income (in ₹)" → "annual_family_income" */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[₹$€£]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097F]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 48) || 'field';
}

/** Make sure ids are unique inside one extraction. */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  const id = `${base}_${i}`;
  taken.add(id);
  return id;
}

/** Normalize a label for fuzzy identity matching across two different forms:
 *  strips punctuation, bilingual parentheses, and common prefixes. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[\u0900-\u097F]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(name|full|of|the|in|figures|only|please|enter|your)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCase(s: string): string {
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Best-effort JSON parse of a model response that may be wrapped in ```json
 *  fences or chatty preamble. Models - on-device especially - sometimes do
 *  this even when asked for bare JSON. */
export function parseJsonLoose<T>(raw: string): T {
  const text = String(raw ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];

  // Also try the outermost {...} or [...] span.
  const firstBrace = text.search(/[[{]/);
  const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  throw new Error('Model response was not valid JSON');
}

/** Count characters as a cheap proxy for prompt size in the router log. */
export const promptChars = (s: string) => s.length;

export function capitalizeFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Stable-ish short hash, used to fingerprint instruction text in metadata
 *  without shipping the text itself to Firestore. FNV-1a 32-bit. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
