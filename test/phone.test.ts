import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone } from '../src/phone';

describe('normalizePhone', () => {
  it('accepts common US formats', () => {
    expect(normalizePhone('(415) 555-0123')).toBe('+14155550123');
    expect(normalizePhone('415.555.0123')).toBe('+14155550123');
    expect(normalizePhone('1 415 555 0123')).toBe('+14155550123');
    expect(normalizePhone('+1 415-555-0123')).toBe('+14155550123');
  });

  it('keeps international numbers that have a +', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
  });

  it('rejects things that are not phone numbers', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('555-0123')).toBeNull();
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('+12')).toBeNull();
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+14155550123')).toBe('•••0123');
  });
});
