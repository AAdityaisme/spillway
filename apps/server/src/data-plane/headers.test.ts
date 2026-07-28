import { describe, it, expect } from 'vitest';
import { droppedParamsHeader } from './headers.js';

describe('droppedParamsHeader', () => {
  it('joins clean names with a comma', () => {
    expect(droppedParamsHeader(['foo', 'bar'])).toBe('foo,bar');
    expect(droppedParamsHeader([])).toBe('');
  });

  it('strips CR/LF/control chars from names (header-injection guard, red-team ADR-034 C1)', () => {
    expect(droppedParamsHeader(['x\r\nX-Injected: 1'])).toBe('xX-Injected: 1');
    expect(droppedParamsHeader(['a\tb', 'c' + String.fromCharCode(0) + 'd'])).toBe('ab,cd');
    // result never contains a CR or LF
    expect(droppedParamsHeader(['p\rq\nr'])).not.toMatch(/[\r\n]/);
  });

  it('drops names that are empty after stripping', () => {
    expect(droppedParamsHeader(['\r\n', 'ok'])).toBe('ok');
    expect(droppedParamsHeader([String.fromCharCode(1, 2, 3)])).toBe('');
  });
});
