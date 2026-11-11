/**
 * Fill output - MVP feature 5.
 *
 * Three deliverables, all generated on-device with no dependency:
 *   1. ANSI overlay   : the original form image with each answer drawn into the
 *                       field's box, plus a coloured confidence border. This is
 *                       the thing judges see on the final screen.
 *   2. Answer sheet   : a plain-text, copyable, WhatsApp-able list of
 *                       "label: value" lines including the flags.
 *   3. Download       : the overlay as a PNG and the sheet as a .txt.
 *
 * Drawing is done on a canvas at the ORIGINAL image resolution so a printout is
 * legible; the on-screen view scales it down via CSS.
 */

import type { FormSession } from '../lib/types';
import { computeLight } from './sessions';

const LIGHT_COLORS = {
  green: { stroke: '#128a4a', fill: 'rgba(18,138,74,0.10)' },
  yellow: { stroke: '#b8791a', fill: 'rgba(184,121,26,0.12)' },
  red: { stroke: '#c0392b', fill: 'rgba(192,57,43,0.10)' },
} as const;

/** The form as a big annotated image. */
export async function renderOverlay(session: FormSession, source: Blob): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    ctx.drawImage(img, 0, 0);

    const fields = session.extraction?.fields ?? [];
    const flagged = new Set(
      (session.verify?.verdicts ?? []).filter((v) => v.status !== 'ok').map((v) => v.fieldId),
    );

    for (const field of fields) {
      const box = field.box;
      if (!box) continue;
      const x = box.x * canvas.width;
      const y = box.y * canvas.height;
      const w = box.w * canvas.width;
      const h = box.h * canvas.height;
      const answer = session.answers[field.id];
      const light = computeLight(field, answer, { cloudFlagged: flagged.has(field.id) });
      const colors = LIGHT_COLORS[light];

      // Confidence border + tint inside the field box.
      ctx.fillStyle = colors.fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = Math.max(2, canvas.width / 600);
      ctx.strokeRect(x, y, w, h);

      if (answer?.value) {
        const fontSize = Math.max(13, Math.min(h * 0.62, canvas.width / 46));
        ctx.font = `${fontSize}px "Segoe UI", system-ui, -apple-system, sans-serif`;
        ctx.fillStyle = '#10161e';
        ctx.textBaseline = 'middle';
        const maxWidth = w - fontSize;
        const text = field.type === 'date' ? formatDateForForm(answer.value) : answer.value;
        ctx.fillText(truncateToWidth(ctx, text, maxWidth), x + fontSize * 0.5, y + h / 2, maxWidth);
      } else if (field.required) {
        ctx.font = `italic ${Math.max(12, Math.min(h * 0.5, canvas.width / 60))}px system-ui, sans-serif`;
        ctx.fillStyle = LIGHT_COLORS.red.stroke;
        ctx.textBaseline = 'middle';
        ctx.fillText('- empty -', x + 10, y + h / 2);
      }

      // A small light dot at the box's top-right so a printed page still shows
      // which fields were verified.
      const r = Math.max(4, canvas.width / 220);
      ctx.beginPath();
      ctx.arc(x + w - r * 2, y + r * 2, r, 0, Math.PI * 2);
      ctx.fillStyle = colors.stroke;
      ctx.fill();
    }

    // Footer strip with provenance - proves the hybrid split on the artefact
    // itself, not just in the UI.
    const stripH = Math.max(34, canvas.height * 0.035);
    ctx.fillStyle = 'rgba(16,22,30,0.88)';
    ctx.fillRect(0, canvas.height - stripH, canvas.width, stripH);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.max(12, stripH * 0.42)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `FormSathi · local answer sheet · review your answers · ${new Date().toLocaleDateString('en-IN')}`,
      stripH * 0.5,
      canvas.height - stripH / 2,
    );

    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('PNG export failed');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** ISO date → the DD/MM/YYYY the printed form expects. */
export function formatDateForForm(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/* ── Answer sheet ─────────────────────────────────────────────────────── */

export interface SheetOptions {
  includeFlags?: boolean;
  includePending?: boolean;
}

/**
 * Plain text answer sheet. Designed to be pasted into WhatsApp to a parent, or
 * read out over the phone to a cyber-cafe operator. That is why it is
 * "label: value" and not a table.
 */
export function buildAnswerSheet(session: FormSession, opts: SheetOptions = {}): string {
  const { includeFlags = true, includePending = true } = opts;
  const fields = session.extraction?.fields ?? [];
  const flagged = new Map(
    (session.verify?.verdicts ?? []).filter((v) => v.status !== 'ok').map((v) => [v.fieldId, v]),
  );

  const lines: string[] = [];
  lines.push(session.title || 'Form');
  if (session.extraction?.authority) lines.push(session.extraction.authority);
  lines.push(`Bhara gaya: ${new Date(session.createdAt).toLocaleDateString('en-IN')}`);
  lines.push('');

  const counts = { green: 0, yellow: 0, red: 0 };

  for (const field of fields) {
    const answer = session.answers[field.id];
    const light = computeLight(field, answer, { cloudFlagged: flagged.has(field.id) });
    counts[light] += 1;

    if (!answer?.value && !includePending && !field.required) continue;

    const mark = light === 'green' ? '✓' : light === 'yellow' ? '!' : '✗';
    const value = answer?.value
      ? field.type === 'date'
        ? formatDateForForm(answer.value)
        : answer.value
      : '(empty)';
    lines.push(`${mark} ${field.label}: ${value}`);

    if (includeFlags && answer?.flagReason) {
      lines.push(`   → ${answer.flagReason}`);
    }
    if (includeFlags && answer?.suggestion) {
      lines.push(`   → correction: ${answer.suggestion}`);
    }
  }

  lines.push('');
  lines.push(`Total ${fields.length} fields - ${counts.green} good, ${counts.yellow} review, ${counts.red} empty.`);
  if (session.verifyStatus === 'queued') {
    lines.push('Cloud verify is queued - it will run automatically when the network returns.');
  } else if (session.verify) {
    lines.push(`Cloud verify: ${session.verify.summary}`);
  }
  lines.push('');
  lines.push('Made with FormSathi. Local answer sheet, not official validation.');
  return lines.join('\n');
}

/* ── Downloads ────────────────────────────────────────────────────────── */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Copy to clipboard with a fallback for browsers without the async API
 *  (which includes the Android WebView some cyber cafes use). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Suggested filename, safe on Android's file picker. */
export function sheetFilename(session: FormSession): string {
  const base = (session.title || 'form')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `formsathi-${base}-answers.txt`;
}

export function overlayFilename(session: FormSession): string {
  const base = (session.title || 'form')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `formsathi-${base}-filled.png`;
}
