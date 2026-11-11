/**
 * Provenance badges — the UI surface of the ModelRouter log.
 *
 * Every answer, every step header and every AI action carries one of these.
 * This is what makes the hybrid story visible on Safari, on a phone, or in a
 * browser where Nano does not exist: the badge tells the truth about which half
 * produced that answer, and the router log drawer proves it call by call.
 */

import { html, raw } from './dom';
import type { RouteLogEntry } from '../lib/types';

export type BadgeKind = 'on-device' | 'cloud' | 'queued' | 'offline' | 'fallback' | 'demo';

export interface BadgeOptions {
  kind: BadgeKind;
  /** Override label (defaults per kind). */
  label?: string;
  /** Tooltip / long-press text. */
  title?: string;
  small?: boolean;
}

const SPEC: Record<BadgeKind, { label: string; icon: string; cls: string }> = {
  'on-device': { label: 'On-device', icon: '📱', cls: 'badge-device' },
  cloud: { label: 'Cloud-verified', icon: '☁️', cls: 'badge-cloud' },
  queued: { label: 'Queue mein', icon: '⏳', cls: 'badge-queued' },
  offline: { label: 'Offline', icon: '✈️', cls: 'badge-offline' },
  fallback: { label: 'Cloud fallback', icon: '↪️', cls: 'badge-fallback' },
  demo: { label: 'Demo', icon: '🧪', cls: 'badge-demo' },
};

export function badge(opts: BadgeOptions): string {
  const spec = SPEC[opts.kind];
  const label = opts.label ?? spec.label;
  return html`<span
    class="badge ${raw(spec.cls)} ${opts.small ? 'badge-sm' : ''}"
    title="${opts.title ?? label}"
    ><span class="badge-ic" aria-hidden="true">${spec.icon}</span
    ><span class="badge-tx">${label}</span></span
  >`.toString();
}

/** Badge for a completed AI call, derived from the router log entry. */
export function badgeForLog(entry: RouteLogEntry | undefined): string {
  if (!entry) return '';
  if (!entry.ok) return badge({ kind: entry.offline ? 'queued' : 'fallback', label: entry.offline ? 'Queue mein' : 'Fail' });
  if (entry.actualPath === 'local') return badge({ kind: 'offline', label: 'Local rules (no AI)' });
  if (entry.actualPath === 'on-device') return badge({ kind: 'on-device', title: entry.reason });
  if (entry.actualPath === 'mock-on-device')
    return badge({ kind: 'on-device', label: 'On-device (demo)', title: entry.reason });
  if (entry.actualPath === 'mock-cloud') return badge({ kind: 'cloud', label: 'Cloud (demo)', title: entry.reason });
  if (entry.requestedPath === 'on-device' && entry.actualPath === 'cloud')
    return badge({ kind: 'fallback', title: entry.reason });
  return badge({ kind: 'cloud', title: entry.reason });
}

/** Traffic light. Colours are also distinguishable by shape/label for
 *  colour-blind users — the brief's "simple traffic light" read literally. */
export function light(kind: 'green' | 'yellow' | 'red', opts: { withLabel?: boolean; size?: 'sm' | 'md' } = {}): string {
  const labels = { green: 'Theek', yellow: 'Dekh lein', red: 'Khali' } as const;
  const titles = {
    green: 'Green — bhara hua hai aur sahi lag raha hai',
    yellow: 'Yellow — bhara hai par ek nazar daalni hai',
    red: 'Red — khali hai, bharna zaroori hai',
  } as const;
  return html`<span
    class="light light-${raw(kind)} ${opts.size === 'sm' ? 'light-sm' : ''}"
    title="${titles[kind]}"
    role="img"
    aria-label="${titles[kind]}"
    ><span class="light-dot" aria-hidden="true"></span
    >${opts.withLabel ? raw(html`<span class="light-tx">${labels[kind]}</span>` .toString()) : ''}</span
  >`.toString();
}

/** Inline counter used in headers: ● 12 ● 2 ● 1 */
export function lightCounts(counts: { green: number; yellow: number; red: number }): string {
  // NOTE: nested html`` results are plain strings, so anything nested inside a
  // tagged template must be wrapped in raw() or it gets escaped back into text.
  return html`<span class="light-counts" aria-label="${counts.green} theek, ${counts.yellow} dekh lein, ${counts.red} khali">
    <span class="light light-green light-sm"><span class="light-dot"></span></span><b>${counts.green}</b>
    <span class="light light-yellow light-sm"><span class="light-dot"></span></span><b>${counts.yellow}</b>
    <span class="light light-red light-sm"><span class="light-dot"></span></span><b>${counts.red}</b>
  </span>`.toString();
}

/** The model/path line shown under a completed step ("gemini-nano · 1.2s · 0 KB uploaded"). */
export function provenanceLine(entry: RouteLogEntry | undefined): string {
  if (!entry) return '';
  const uploaded = entry.actualPath === 'cloud' || entry.actualPath === 'mock-cloud';
  const kb = uploaded && entry.imageBytes ? `${Math.round(entry.imageBytes / 1024)} KB` : '0 KB';
  const lat = entry.latencyMs >= 1000 ? `${(entry.latencyMs / 1000).toFixed(1)}s` : `${entry.latencyMs}ms`;
  return html`<p class="prov">
    <span class="prov-model">${entry.model}</span>
    <span class="prov-sep">·</span><span>${lat}</span>
    <span class="prov-sep">·</span><span>${kb} uploaded</span>
    ${entry.redacted ? raw(`<span class="prov-sep">·</span><span class="prov-lock">🔒 redacted</span>`) : ''}
  </p>`.toString();
}

export const BADGE_CSS_HINT = 'badges are styled in styles.css under .badge-*';
