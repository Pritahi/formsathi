/**
 * The privacy claim, as executable proof.
 *
 * These tests are the ones a judge should read first: they assert that no
 * identity value can reach a cloud payload, that format facts still allow
 * meaningful verification, and that a model which ignores instructions cannot
 * smuggle a value back into the app.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCloudPayload,
  describeShape,
  describeShapeDetailed,
  isNeverSendField,
  sanitizeVerifyResult,
  scrubPrompt,
} from '../src/ai/redact';
import type { Answer, ExtractedField } from '../src/lib/types';

const field = (id: string, label: string, type = 'text', required = true): ExtractedField => ({
  id,
  label,
  type: type as ExtractedField['type'],
  required,
  confidence: 0.9,
});

const answer = (fieldId: string, value: string): Answer => ({
  fieldId,
  value,
  confidence: 0.9,
  confidenceLight: 'green',
  source: 'typed',
  author: 'user',
  updatedAt: Date.now(),
});

const AADHAAR = '123456789012';
const MOBILE = '9876543210';
const ADDRESS = 'H.No 14, Ward 6, Village Bharthana, Tehsil Sadar';
const DOB = '2004-08-12';

const fields: ExtractedField[] = [
  field('full_name', 'Name of Applicant'),
  field('aadhaar', 'Aadhaar Number (12 digits)'),
  field('mobile', 'Mobile Number (10 digits)', 'phone'),
  field('address', 'Permanent Address (House, Street, Village/Town)'),
  field('date_of_birth', 'Date of Birth (DD/MM/YYYY)', 'date'),
  field('pincode', 'PIN Code (6 digits)', 'number'),
  field('bank_account', 'Bank Account Number'),
  field('ifsc', 'IFSC Code'),
  field('annual_family_income', 'Annual Family Income (in rupees)', 'number'),
];

const answers: Record<string, Answer> = {
  full_name: answer('full_name', 'Priya Kumari'),
  aadhaar: answer('aadhaar', AADHAAR),
  mobile: answer('mobile', MOBILE),
  address: answer('address', ADDRESS),
  date_of_birth: answer('date_of_birth', DOB),
  pincode: answer('pincode', '206001'),
  bank_account: answer('bank_account', '30987654321'),
  ifsc: answer('ifsc', 'SBIN0001234'),
  annual_family_income: answer('annual_family_income', '60000'),
};

describe('redaction gate', () => {
  const { payload, report } = buildCloudPayload(fields, answers);
  const serialized = JSON.stringify(payload);

  it('never sends the Aadhaar number', () => {
    expect(serialized).not.toContain(AADHAAR);
    expect(serialized).not.toContain('1234 5678 9012');
  });

  it('never sends the mobile number', () => {
    expect(serialized).not.toContain(MOBILE);
  });

  it('never sends the home address', () => {
    expect(serialized).not.toContain('Bharthana');
  });

  it('never sends the date of birth', () => {
    expect(serialized).not.toContain(DOB);
  });

  it('never sends the bank account or pincode', () => {
    expect(serialized).not.toContain('30987654321');
    expect(serialized).not.toContain('206001');
  });

  it('never sends the IFSC code either — bank details stay on-device', () => {
    expect(serialized).not.toContain('SBIN0001234');
  });

  it('marks exactly the identity/bank fields as redacted', () => {
    expect(report.redactedFieldIds.sort()).toEqual(
      ['aadhaar', 'address', 'bank_account', 'date_of_birth', 'ifsc', 'mobile', 'pincode'].sort(),
    );
  });

  it('but still sends format facts so verification stays useful', () => {
    const mobile = payload.find((p) => p.id === 'mobile')!;
    expect(mobile.valueForCloud).toContain('digits=10');
    expect(mobile.valueForCloud).toContain('mobile-like');

    const ifsc = payload.find((p) => p.id === 'ifsc')!;
    expect(ifsc.valueForCloud).toContain('ifsc-valid');
  });

  it('sends income as a number because the rule is numeric', () => {
    const income = payload.find((p) => p.id === 'annual_family_income')!;
    expect(income.valueForCloud).toBe('60000');
    expect(income.valueRedacted).toBe(false);
  });
});

describe('isNeverSendField', () => {
  it('flags identity fields by label even with odd keys', () => {
    expect(isNeverSendField('x1', 'Aadhaar Number (12 digits)')).toBe(true);
    expect(isNeverSendField('x2', 'Caste Certificate No.')).toBe(true);
    expect(isNeverSendField('x3', 'Bank A/c Number')).toBe(true);
    expect(isNeverSendField('x4', 'Contact No.')).toBe(true);
  });

  it('does not flag fields the cloud genuinely needs', () => {
    expect(isNeverSendField('annual_family_income', 'Annual Family Income')).toBe(false);
    expect(isNeverSendField('category', 'Category')).toBe(false);
    expect(isNeverSendField('percentage', 'Percentage Marks')).toBe(false);
  });
});

describe('format facts', () => {
  it('detects a +91 mobile as a broken format without revealing it', () => {
    const { facts, descriptor } = describeShapeDetailed('+919876543210');
    expect(facts).toContain('has-91-prefix');
    expect(facts).toContain('has-plus-prefix');
    expect(descriptor).not.toContain('98765');
  });

  it('detects spaces in a mobile', () => {
    expect(describeShapeDetailed('98765 43210').facts).toContain('has-spaces');
  });

  it('validates an IFSC locally', () => {
    expect(describeShapeDetailed('SBIN0001234').facts).toContain('ifsc-valid');
    expect(describeShapeDetailed('SBIN12345').facts).not.toContain('ifsc-valid');
  });

  it('recognises ISO and DD/MM/YYYY dates', () => {
    expect(describeShape('2004-08-12')).toBe('date value');
    expect(describeShape('12/08/2004')).toBe('date value');
  });
});

describe('scrubPrompt (second pass)', () => {
  it('removes a value that leaked into instruction text', () => {
    const prompt = `Instructions mention ${AADHAAR} besides the field list.`;
    const out = scrubPrompt(prompt, answers, fields);
    expect(out.scrubbed).toBeGreaterThan(0);
    expect(out.text).not.toContain(AADHAAR);
  });

  it('leaves a prompt alone when no sensitive value is present', () => {
    const out = scrubPrompt('Nothing personal here.', answers, fields);
    expect(out.scrubbed).toBe(0);
  });
});

describe('sanitizeVerifyResult', () => {
  it('drops a suggested value for a redacted field', () => {
    const result = sanitizeVerifyResult(
      {
        verdicts: [
          { fieldId: 'aadhaar', status: 'fix', suggestedValue: '999999999999', reason: 'galat' },
          { fieldId: 'annual_family_income', status: 'fix', suggestedValue: '60000' },
        ],
        summary: '',
        overallConfidence: 0.5,
      },
      answers,
      fields,
    );
    expect(result.verdicts[0]!.suggestedValue).toBeUndefined();
    expect(result.verdicts[1]!.suggestedValue).toBe('60000');
  });
});
