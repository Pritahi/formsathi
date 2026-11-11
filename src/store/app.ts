/**
 * App-level state: settings, boot status, and the small amount of state that
 * several screens need at once.
 *
 * Deliberately not a state library. Screens re-render themselves; this module
 * only owns the things that outlive a screen (settings, capability, pending
 * queue count) and notifies subscribers.
 */

import { kv } from '../lib/idb';
import { DEFAULT_DEMO_MODE, FEATURES } from '../config/config';
import { routerState, setDemoMode, setSimulatedOffline, refreshCapability } from '../ai/router';
import { pendingCount } from '../services/sync';
import { initFirebase, firebaseStatus, type FirebaseStatus } from '../services/firebase';
import { trySilentUnlock, vaultExists, vaultState, getVaultMeta } from '../vault/vault';
import { requestPersistentStorage } from '../lib/idb';

export interface Settings {
  demoMode: boolean;
  simulatedOffline: boolean;
  voiceOutput: boolean;
  voiceInput: boolean;
  /** DEMO: which mistake cloud verify should reproduce. */
  demoVerifyProfile: 'income-monthly' | 'clean' | 'wrong-ifsc' | 'plus91';
  /** Show the router log drawer button in the top bar. */
  showRouterButton: boolean;
  saveToVaultAutomatically: boolean;
}

const SETTINGS_KEY = 'settings_v1';

const DEFAULT_SETTINGS: Settings = {
  demoMode: DEFAULT_DEMO_MODE,
  simulatedOffline: false,
  voiceOutput: FEATURES.voiceOutput,
  voiceInput: FEATURES.voiceInput,
  demoVerifyProfile: 'income-monthly',
  showRouterButton: true,
  saveToVaultAutomatically: true,
};

export interface AppState {
  booted: boolean;
  settings: Settings;
  firebase: FirebaseStatus;
  vaultUnlocked: boolean;
  vaultPresent: boolean;
  vaultMode: 'passphrase' | 'quick' | null;
  pending: number;
  online: boolean;
  installed: boolean;
}

export const state: AppState = {
  booted: false,
  settings: { ...DEFAULT_SETTINGS },
  firebase: firebaseStatus,
  vaultUnlocked: false,
  vaultPresent: false,
  vaultMode: null,
  pending: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  installed: false,
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn(state);
}

export async function loadSettings(): Promise<void> {
  const saved = await kv.get<Partial<Settings>>(SETTINGS_KEY);
  state.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  setDemoMode(state.settings.demoMode);
  setSimulatedOffline(state.settings.simulatedOffline);
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  state.settings = { ...state.settings, ...patch };
  await kv.set(SETTINGS_KEY, state.settings);
  // Keep the router in sync with the two settings that change its behaviour.
  if (patch.demoMode !== undefined) setDemoMode(patch.demoMode);
  if (patch.simulatedOffline !== undefined) setSimulatedOffline(patch.simulatedOffline);
  notify();
}

/**
 * One-time boot. Everything here is defensive: a failure in Firebase or the
 * vault must never stop the app from opening.
 */
export async function boot(): Promise<void> {
  await loadSettings();

  state.installed = window.matchMedia('(display-mode: standalone)').matches;

  // Storage: ask for persistence AFTER first paint so it never blocks boot.
  setTimeout(() => void requestPersistentStorage(), 1500);

  // Vault presence + silent unlock (quick mode only).
  try {
    state.vaultPresent = await vaultExists();
    if (state.vaultPresent) {
      const unlocked = await trySilentUnlock();
      state.vaultUnlocked = unlocked || vaultState.unlocked;
      state.vaultMode = (await getVaultMeta())?.mode ?? null;
    }
  } catch {
    state.vaultPresent = false;
  }

  // Capability probe: cheap, and it decides every badge for the session.
  if (!state.settings.demoMode) {
    void refreshCapability(true);
  }

  // Firebase: only when configured. Never blocks.
  void initFirebase().then((status) => {
    state.firebase = status;
    notify();
  });

  state.pending = await pendingCount();

  const updateOnline = () => {
    state.online = navigator.onLine;
    notify();
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  state.booted = true;
  notify();
}

/** Keep the pending badge honest. */
export async function refreshPending(): Promise<void> {
  state.pending = await pendingCount();
  notify();
}

export function isDemo(): boolean {
  return state.settings.demoMode;
}

export function isSimulatedOffline(): boolean {
  return routerState.simulatedOffline;
}

/** Effective offline: simulated flag OR the real radio. */
export function isOfflineNow(): boolean {
  return state.settings.simulatedOffline || !state.online;
}

