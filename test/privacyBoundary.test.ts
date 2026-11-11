import { describe, it, expect } from 'vitest';
import { callModel } from '../src/ai/firebaseAi';
import { routerState, setDemoMode, routeInterviewTurn, routeNormalizeAnswer } from '../src/ai/router';
import { FIREBASE_CONFIG } from '../src/config/config';

describe('unpaid cloud boundary', () => {
  it('rejects free-form personal payload before initializing Firebase or fetching', async () => {
    await expect(callModel(FIREBASE_CONFIG, { prompt: 'private answer', prefer: 'cloud' })).rejects.toThrow('Privacy guard');
  });
  it('requires eligible-adult session confirmation even for synthetic content', async () => {
    await expect(callModel(FIREBASE_CONFIG, { prompt: 'fictional', prefer: 'cloud', syntheticOnly: true })).rejects.toThrow('Privacy guard');
  });
  it('keeps answer normalization local when Nano is unavailable', async () => {
    setDemoMode(false); routerState.capability = null;
    const out = await routeNormalizeAnswer({ field: { id: 'name', label: 'Name', type: 'text' }, raw: 'Example Name' });
    expect(out.log.actualPath).toBe('local');
    expect(out.log.model).toContain('no AI');
  });
  it('keeps interview state local when Nano is unavailable', async () => {
    setDemoMode(false); routerState.capability = null;
    const out = await routeInterviewTurn({ state: { formTitle: 'Sample', formType: 'other', known: {}, remaining: [{ id: 'name', label: 'Name', type: 'text' }], currentFieldId: 'name', language: 'hinglish' } });
    expect(out.log.actualPath).toBe('local');
  });
});
