/**
 * Small read helpers over the router log, so screens can show provenance
 * without reaching into router internals (and without causing import cycles).
 */

import type { RouteLogEntry, RouteTask } from '../lib/types';
import { routerState } from './router';

/** Most recent successful call for a session + task. */
export function getLastRouteLog(sessionId: string, task: RouteTask): RouteLogEntry | undefined {
  return routerState.logs.find((l) => l.sessionId === sessionId && l.task === task && l.ok);
}

/** Any call, successful or not - used to show a queued/failed state. */
export function getLastRouteLogAny(sessionId: string, task: RouteTask): RouteLogEntry | undefined {
  return routerState.logs.find((l) => l.sessionId === sessionId && l.task === task);
}

/** Aggregate per-session split, for the result screen's provenance panel. */
export function sessionSplit(sessionId: string): {
  onDevice: number;
  cloud: number;
  bytesUp: number;
  redactedCalls: number;
} {
  const logs = routerState.logs.filter((l) => l.sessionId === sessionId);
  return {
    onDevice: logs.filter((l) => l.actualPath === 'on-device' || l.actualPath === 'mock-on-device').length,
    cloud: logs.filter((l) => l.actualPath === 'cloud' || l.actualPath === 'mock-cloud').length,
    bytesUp: logs.reduce((sum, l) => sum + (l.imageBytes ?? 0), 0),
    redactedCalls: logs.filter((l) => l.redacted).length,
  };
}
