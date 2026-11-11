import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ modes: [] as string[], source: 'in_cloud', calls: [] as string[] }));
vi.mock('firebase/app', () => ({ getApps: () => [{}], getApp: () => ({}), initializeApp: () => ({}) }));
vi.mock('../src/services/appCheck', () => ({ ensureAppCheck: vi.fn() }));
vi.mock('firebase/ai', () => ({
  GoogleAIBackend: class {}, getAI: () => ({}),
  InferenceMode: { ONLY_ON_DEVICE: 'only_on_device', PREFER_ON_DEVICE: 'prefer_on_device' },
  getGenerativeModel: (_ai: unknown, options: { mode?: string }) => {
    const mode = options.mode ?? 'cloud'; state.modes.push(mode);
    return {
      initializeDeviceModel: async () => {},
      generateContent: async () => {
        state.calls.push(mode);
        return { response: { inferenceSource: state.source, text: () => '{"title":"Synthetic","fields":[{"label":"Name","type":"text"}]}' } };
      },
    };
  },
}));
import { callModel } from '../src/ai/firebaseAi';
import { FIREBASE_CONFIG } from '../src/config/config';
afterEach(() => vi.unstubAllGlobals());
describe('SDK hybrid path, mocked SDK contract only', () => {
  it('constructs and calls PREFER_ON_DEVICE for eligible synthetic samples and reports cloud fallback', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'yes' });
    state.source = 'in_cloud';
    const out = await callModel(FIREBASE_CONFIG, { prompt: 'bundled blank synthetic form', prefer: 'hybrid', syntheticOnly: true });
    expect(state.modes).toContain('prefer_on_device');
    expect(state.calls.at(-1)).toBe('prefer_on_device');
    expect(out.path).toBe('cloud'); expect(out.fellBack).toBe(true);
  });
  it('reports the SDK on-device source without claiming fallback', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'yes' }); state.source = 'on_device';
    const out = await callModel(FIREBASE_CONFIG, { prompt: 'bundled blank synthetic form', prefer: 'hybrid', syntheticOnly: true });
    expect(out.path).toBe('on-device'); expect(out.fellBack).toBe(false);
  });
  it('uses ONLY_ON_DEVICE for personal content and rejects an unexpected cloud source', async () => {
    state.source = 'in_cloud';
    await expect(callModel(FIREBASE_CONFIG, { prompt: 'private', prefer: 'on-device' })).rejects.toThrow('Privacy guard');
    expect(state.calls.at(-1)).toBe('only_on_device');
  });
});
