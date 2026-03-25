import { describe, it, expect } from 'vitest';
import { rejectControlChars, rejectNullBytes } from '../src/domain/validate.js';

describe('rejectNullBytes', () => {
  it('allows normal strings', () => {
    expect(() => rejectNullBytes('hello world', 'test')).not.toThrow();
  });

  it('rejects strings with null bytes', () => {
    expect(() => rejectNullBytes('bad\x00value', 'test')).toThrow('null bytes');
  });

  it('includes field name in error', () => {
    expect(() => rejectNullBytes('bad\x00', 'myField')).toThrow('"myField"');
  });
});

describe('rejectControlChars', () => {
  it('allows normal strings', () => {
    expect(() => rejectControlChars('hello world', 'test')).not.toThrow();
  });

  it('allows newlines and tabs (not in control char pattern)', () => {
    expect(() => rejectControlChars('line1\nline2', 'test')).not.toThrow();
    expect(() => rejectControlChars('col1\tcol2', 'test')).not.toThrow();
  });

  it('rejects SOH (0x01)', () => {
    expect(() => rejectControlChars('bad\x01value', 'test')).toThrow('control characters');
  });

  it('rejects BEL (0x07)', () => {
    expect(() => rejectControlChars('bad\x07value', 'test')).toThrow('control characters');
  });

  it('rejects DEL (0x7f)', () => {
    expect(() => rejectControlChars('bad\x7fvalue', 'test')).toThrow('control characters');
  });

  it('rejects vertical tab (0x0b)', () => {
    expect(() => rejectControlChars('bad\x0bvalue', 'test')).toThrow('control characters');
  });

  it('rejects form feed (0x0c)', () => {
    expect(() => rejectControlChars('bad\x0cvalue', 'test')).toThrow('control characters');
  });

  it('allows carriage return (0x0d)', () => {
    expect(() => rejectControlChars('line1\r\nline2', 'test')).not.toThrow();
  });
});
