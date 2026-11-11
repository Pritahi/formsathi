/**
 * ModelRouter contract tests.
 *
 * The hybrid map is the product's central claim, so it is asserted, not just
 * documented: the on-device/cloud split must match the README, the interview
 * must always be routed on-device with single-turn prompts, and the log must
 * record a truthful path for every call.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  ROUTE_TABLE,
  planRoute,
  hybridSnapshot,
  setDemoMode,
  routeInterviewTurn,
  routeCloudVerify,
  onRouterLog,
  setSessionContext,
  routerState,
} from '../src/ai/router';
import type { RouteTask } from '../src/lib/types';

beforeEach(() => {
  setDemoMode(true);
  routerState.logs = [];
  routerState.capability = null;
  routerState.onDeviceDisabled = false;
  setSessionContext('test-session');
});

describe('hybrid inference map', () => {
  const onDevice: RouteTask[] = ['field_extraction', 'interview_turn', 'answer_repair'];
  const cloud: RouteTask[] = ['cloud_verify', 'review_summary', 'freeform_chat'];

  it('keeps every privacy-bearing step on-device', () => {
    for (const task of onDevice) {
      expect(ROUTE_TABLE[task].path).toBe('on-device');
      expect(ROUTE_TABLE[task].privateByDesign).toBe(true);
    }
  });

  it('keeps every long-context step in the cloud', () => {
    for (const task of cloud) {
      expect(ROUTE_TABLE[task].path).toBe('cloud');
    }
  });

  it('declares whether each step can run with no network', () => {
    expect(ROUTE_TABLE.field_extraction.offlineCapable).toBe(true);
    expect(ROUTE_TABLE.interview_turn.offlineCapable).toBe(true);
    expect(ROUTE_TABLE.cloud_verify.offlineCapable).toBe(false);
  });

  it('routes free-form chat to cloud even if asked for on-device', () => {
    const plan = planRoute('freeform_chat');
    expect(plan.effective).toBe('cloud');
    expect(plan.reason).toMatch(/multi-turn/i);
  });

  it('never plans cloud_verify on-device', () => {
    expect(planRoute('cloud_verify').effective).toBe('cloud');
  });
});

describe('interview turns', () => {
  it('logs exactly one single-turn call per turn with the packed state', async () => {
    const logs: unknown[] = [];
    const off = onRouterLog((l) => logs.push(l));
    const { turn, log } = await routeInterviewTurn({
      state: {
        formTitle: 'Scholarship',
        formType: 'scholarship',
        remaining: [
          { id: 'full_name', label: 'Name of Applicant', type: 'text' },
          { id: 'mobile', label: 'Mobile Number', type: 'phone' },
        ],
        known: {},
        currentFieldId: 'full_name',
        language: 'hinglish',
      },
    });
    off();

    expect(log.task).toBe('interview_turn');
    expect(log.actualPath).toBe('mock-on-device');
    expect(log.redacted).toBe(true);
    expect(turn.done).toBe(false);
    // The prompt is built from packed state, so it must carry the field ids and
    // must be short enough for Nano (this is a regression guard on prompt bloat).
    expect(log.promptChars).toBeGreaterThan(200);
    expect(log.promptChars).toBeLessThan(2000);
    expect(logs.length).toBe(1);
  });

  it('moves on when a field is already known', async () => {
    const { turn } = await routeInterviewTurn({
      state: {
        formTitle: 'Scholarship',
        formType: 'scholarship',
        remaining: [
          { id: 'full_name', label: 'Name of Applicant', type: 'text' },
          { id: 'district', label: 'District', type: 'text' },
        ],
        known: { full_name: 'Priya' },
        currentFieldId: 'district',
        language: 'hinglish',
      },
    });
    expect(turn.fieldId).toBe('district');
  });

  it('closes the interview when nothing is left', async () => {
    const { turn } = await routeInterviewTurn({
      state: {
        formTitle: 'Scholarship',
        formType: 'scholarship',
        remaining: [],
        known: { a: '1', b: '2' },
        currentFieldId: '',
        language: 'hinglish',
      },
    });
    expect(turn.done).toBe(true);
  });
});

describe('cloud verify routing', () => {
  it('records a cloud call and reports redaction', async () => {
    const { log, result } = await routeCloudVerify({
      formTitle: 'Scholarship',
      formType: 'scholarship',
      instructionText: 'Income must be annual, in figures only.',
      fields: [
        {
          id: 'mobile',
          label: 'Mobile Number',
          type: 'phone',
          required: true,
          valueForCloud: '10-digit number (mobile-like) [format: digits=10, chars=10]',
          valueRedacted: true,
        },
      ],
    });
    expect(log.task).toBe('cloud_verify');
    expect(log.actualPath).toBe('mock-cloud');
    expect(log.redacted).toBe(true);
    expect(log.requestedPath).toBe('cloud');
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it('catches a monthly income entry', async () => {
    const { result } = await routeCloudVerify({
      formTitle: 'Scholarship',
      formType: 'scholarship',
      instructionText: 'Income must be annual, in figures only. Limit is Rs. 2,50,000.',
      fields: [
        {
          id: 'annual_family_income',
          label: 'Annual Family Income',
          type: 'number',
          required: true,
          valueForCloud: '5000',
          valueRedacted: false,
        },
      ],
    });
    const verdict = result.verdicts.find((v) => v.fieldId === 'annual_family_income');
    expect(verdict?.status).toBe('fix');
    expect(verdict?.reason).toMatch(/annual|year|monthly/i);
    expect(verdict?.suggestedValue).toBe('60000');
  });
});

describe('snapshot', () => {
  it('reports the split that the README table describes', () => {
    const snap = hybridSnapshot();
    expect(snap.onDeviceTasks).toEqual(
      expect.arrayContaining(['field_extraction', 'interview_turn', 'answer_repair']),
    );
    expect(snap.cloudTasks).toEqual(
      expect.arrayContaining(['cloud_verify', 'freeform_chat', 'review_summary']),
    );
  });
});

describe('offline behaviour', () => {
  it('refuses cloud verify while offline, in demo mode too', async () => {
    const { setSimulatedOffline, clearRouterLog } = await import('../src/ai/router');
    setSimulatedOffline(true);
    clearRouterLog();
    try {
      await expect(
        routeCloudVerify({
          formTitle: 'Scholarship',
          formType: 'scholarship',
          instructionText: 'Income must be annual.',
          fields: [
            {
              id: 'annual_family_income',
              label: 'Annual Family Income',
              type: 'number',
              required: true,
              valueForCloud: '5000',
              valueRedacted: false,
            },
          ],
        }),
      ).rejects.toThrow(/offline/);

      // …and the refusal is logged with ok:false, not silently swallowed.
      const entry = routerState.logs.find((l) => l.task === 'cloud_verify');
      expect(entry?.ok).toBe(false);
      expect(entry?.offline).toBe(true);
    } finally {
      setSimulatedOffline(false);
    }
  });

  it('still runs the on-device interview while offline', async () => {
    const { setSimulatedOffline } = await import('../src/ai/router');
    setSimulatedOffline(true);
    try {
      const { turn, log } = await routeInterviewTurn({
        state: {
          formTitle: 'Scholarship',
          formType: 'scholarship',
          remaining: [{ id: 'district', label: 'District', type: 'text' }],
          known: {},
          currentFieldId: 'district',
          language: 'hinglish',
        },
      });
      expect(log.actualPath).toBe('mock-on-device');
      expect(log.offline).toBe(true);
      expect(turn.done).toBe(false);
    } finally {
      setSimulatedOffline(false);
    }
  });
});
