import { describe, it, expect } from 'vitest';
import { BufbuildConditionEvaluator, type AttributeActivation } from './condition-evaluator.js';
import { CelCompileError } from './bounds.js';

const activation = (over: Partial<AttributeActivation> = {}): AttributeActivation => ({
  identity: { org_id: 'o', virtual_key_id: 'vk', key_tags: [] },
  request: { model_requested: 'gpt-4o', stream: true, has_tools: false, tool_count: 0 },
  spend: {},
  time: {},
  ...over,
});

describe('BufbuildConditionEvaluator (16 §5, B4)', () => {
  const ev = new BufbuildConditionEvaluator();

  it('compiles a valid bool condition + records refs', () => {
    const c = ev.compile('request.stream == true');
    expect(c.refs).toContain('request.stream');
    expect(ev.run(c, activation())).toBe(true);
    expect(ev.run(c, activation({ request: { stream: false } }))).toBe(false);
  });

  it('rejects global-form matches(x, pat) — regex-bound bypass + no runtime overload (red-team B7)', () => {
    // receiver form is fine
    expect(() => ev.compile('request.model_requested.matches("gpt-.*")')).not.toThrow();
    // global form → cel_type_error at authoring (would always error at runtime → fail-closed deny)
    try {
      ev.compile('matches(request.model_requested, "gpt-.*")');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CelCompileError).code).toBe('cel_type_error');
    }
    // an over-long global-form regex is also caught by the (now position-correct) length bound
    const longPat = 'a'.repeat(200);
    expect(() => ev.compile(`request.model_requested.matches("${longPat}")`)).toThrow(
      CelCompileError,
    );
  });

  it('rejects a banned comprehension macro (cel_banned_macro)', () => {
    expect(() => ev.compile('[1, 2].all(x, x > 0)')).toThrow(CelCompileError);
    try {
      ev.compile('[1, 2].exists(x, x > 0)');
    } catch (e) {
      expect((e as CelCompileError).code).toBe('cel_banned_macro');
    }
  });

  it('rejects an unknown attribute (cel_type_error)', () => {
    try {
      ev.compile('request.nonexistent == "x"');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CelCompileError).code).toBe('cel_type_error');
    }
  });

  it('rejects a non-bool result (cel_type_error)', () => {
    try {
      ev.compile('request.tool_count');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CelCompileError).code).toBe('cel_type_error');
    }
  });

  it('evalCondition fails CLOSED for enforce, OPEN for shadow on a runtime error', () => {
    // temperature is absent from the activation → unguarded read raises at runtime.
    const c = ev.compile('request.temperature > 0.5');
    expect(ev.evalCondition(c, activation(), 'enforce')).toBe(true); // fail closed → treat as match
    expect(ev.evalCondition(c, activation(), 'shadow')).toBe(false); // fail open → no match
  });
});
