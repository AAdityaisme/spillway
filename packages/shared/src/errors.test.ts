import { describe, it, expect } from 'vitest';
import {
  SpillwayError,
  controlPlaneErrorBody,
  openaiErrorBody,
  blockBody,
  policyDenyBody,
  approvalRequiredBody,
  budget402Body,
  rateLimit429Body,
  rateLimitHeaders,
  budgetBlockHeaders,
  guardrailBlockHeaders,
} from './errors.js';

describe('SpillwayError', () => {
  it('carries code, httpStatus, and a derived docs url', () => {
    const err = new SpillwayError('budget_exceeded', 'Budget exceeded: $20.00 of $20.00 (day)', {
      httpStatus: 402,
      details: { scope_type: 'virtual_key', period: 'day' },
    });
    expect(err.type).toBe('spillway_error');
    expect(err.code).toBe('budget_exceeded');
    expect(err.httpStatus).toBe(402);
    expect(err.docsUrl).toBe('https://docs.spillway.dev/errors/budget_exceeded');
    expect(err).toBeInstanceOf(Error);
  });

  it('never leaks the underlying cause into the serialized control-plane body', () => {
    const err = new SpillwayError('upstream_error', 'provider returned 500', {
      httpStatus: 502,
      cause: new Error('sk-secret-leaked-key'),
    });
    const body = controlPlaneErrorBody(err);
    expect(body).toEqual({
      error: {
        code: 'upstream_error',
        message: 'provider returned 500',
        docs_url: 'https://docs.spillway.dev/errors/upstream_error',
      },
    });
    expect(JSON.stringify(body)).not.toContain('sk-secret-leaked-key');
  });

  it('includes structured details when provided', () => {
    const err = new SpillwayError('rate_limited', 'too many requests', {
      httpStatus: 429,
      details: { retry_after_ms: 1200 },
    });
    expect(controlPlaneErrorBody(err).error.details).toEqual({ retry_after_ms: 1200 });
  });

  it('openaiErrorBody renders the provider-shaped data-plane body (no cause leak)', () => {
    const err = new SpillwayError('model_not_found', 'unknown model: gpt-9', {
      httpStatus: 404,
      details: { param: 'model' },
      cause: new Error('sk-secret'),
    });
    expect(openaiErrorBody(err)).toEqual({
      error: {
        message: 'unknown model: gpt-9',
        type: 'spillway_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
    // param defaults to null when absent
    const noParam = new SpillwayError('service_unavailable', 'down', { httpStatus: 503 });
    expect(openaiErrorBody(noParam).error.param).toBeNull();
    expect(JSON.stringify(openaiErrorBody(err))).not.toContain('sk-secret');
  });

  it('accepts the M3 governance codes (union widened — B0.6)', () => {
    const noRoute = new SpillwayError('no_route_available', 'no dispatchable candidate', {
      httpStatus: 503,
    });
    const approval = new SpillwayError('approval_required', 'approval required', {
      httpStatus: 403,
    });
    expect(noRoute.code).toBe('no_route_available');
    expect(approval.code).toBe('approval_required');
  });
});

// M47: wire-contract tests for block-body builders and header helpers.
// A refactor that renames block_reason, drops spillway.*, or changes header casing must fail here.
describe('block-body wire contract (M47)', () => {
  const ruleErr = new SpillwayError('rule_deny', 'policy denied request', {
    httpStatus: 403,
    details: { policy_id: 'p1', decision_id: 'd1' },
  });
  const budgetErr = new SpillwayError('budget_exceeded', 'over budget', {
    httpStatus: 402,
    details: {
      scope_type: 'virtual_key',
      scope_id: 'vk-uuid',
      period: 'day',
      period_key: '2026-07',
      spent_usd: '100.00',
      limit_usd: '100.00',
    },
  });
  const approvalErr = new SpillwayError('approval_required', 'requires approval', {
    httpStatus: 403,
    details: { policy_id: 'p2', decision_id: 'd2', approval_request_id: 'ar1' },
  });

  it('blockBody: code==block_reason, param==null, spillway wrapper present', () => {
    const body = blockBody(ruleErr);
    expect(body.error.code).toBe('rule_deny');
    expect(body.error.param).toBeNull();
    expect(body.error.type).toBe('spillway_error');
    expect(body.error.spillway.block_reason).toBe('rule_deny');
    expect(body.error.message).toBe('policy denied request');
  });

  it('blockBody: extra spillway keys are merged without overwriting block_reason', () => {
    const body = blockBody(ruleErr, { custom: 'value' });
    expect(body.error.spillway.block_reason).toBe('rule_deny');
    expect(body.error.spillway.custom).toBe('value');
  });

  it('policyDenyBody: carries policy_id and decision_id; null when absent', () => {
    const body = policyDenyBody(ruleErr);
    expect(body.error.spillway.policy_id).toBe('p1');
    expect(body.error.spillway.decision_id).toBe('d1');
    // absent approval_request_id is not present in this body (policyDenyBody does not set it)
    expect(Object.keys(body.error.spillway)).not.toContain('approval_request_id');
    // absent details defaults to null
    const noDetails = new SpillwayError('rule_deny', 'm', { httpStatus: 403 });
    const nb = policyDenyBody(noDetails);
    expect(nb.error.spillway.policy_id).toBeNull();
    expect(nb.error.spillway.decision_id).toBeNull();
  });

  it('approvalRequiredBody: carries policy_id, decision_id, and approval_request_id', () => {
    const body = approvalRequiredBody(approvalErr);
    expect(body.error.spillway.policy_id).toBe('p2');
    expect(body.error.spillway.decision_id).toBe('d2');
    expect(body.error.spillway.approval_request_id).toBe('ar1');
  });

  it('budget402Body: carries all six budget-block spillway fields', () => {
    const body = budget402Body(budgetErr);
    expect(body.error.spillway.scope_type).toBe('virtual_key');
    expect(body.error.spillway.scope_id).toBe('vk-uuid');
    expect(body.error.spillway.period).toBe('day');
    expect(body.error.spillway.period_key).toBe('2026-07');
    expect(body.error.spillway.spent_usd).toBe('100.00');
    expect(body.error.spillway.limit_usd).toBe('100.00');
    // absent fields default to null
    const sparse = new SpillwayError('budget_exceeded', 'over', { httpStatus: 402 });
    const sb = budget402Body(sparse);
    expect(sb.error.spillway.scope_type).toBeNull();
  });

  it('rateLimit429Body: canonical nested envelope with block_reason + retry_after (COMPAT N-4)', () => {
    const err = new SpillwayError('rate_limited', 'too many', {
      httpStatus: 429,
      details: { retry_after: 1.3 },
    });
    const body = rateLimit429Body(err);
    expect(body.error.type).toBe('spillway_error');
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.param).toBeNull();
    expect(body.error.spillway.block_reason).toBe('rate_limited');
    expect(body.error.spillway.retry_after).toBe(2); // Math.ceil(1.3)
  });
});

describe('header-builder wire contract (M47)', () => {
  it('rateLimitHeaders: defaults to 1, ceilings fractional values, ignores non-positive', () => {
    const base = new SpillwayError('rate_limited', 'too many', { httpStatus: 429 });
    expect(rateLimitHeaders(base)['retry-after']).toBe('1');
    expect(rateLimitHeaders(base)['x-spillway-block-reason']).toBe('rate_limited'); // COMPAT N-4

    const withRa = new SpillwayError('rate_limited', 'too many', {
      httpStatus: 429,
      details: { retry_after: 1.3 },
    });
    expect(rateLimitHeaders(withRa)['retry-after']).toBe('2'); // Math.ceil(1.3)

    const zero = new SpillwayError('rate_limited', 'too many', {
      httpStatus: 429,
      details: { retry_after: 0 },
    });
    expect(rateLimitHeaders(zero)['retry-after']).toBe('1'); // non-positive → default
  });

  it('budgetBlockHeaders: only emits present string fields', () => {
    const err = new SpillwayError('budget_exceeded', 'over', {
      httpStatus: 402,
      details: { scope_type: 'org', period: 'day' },
    });
    const hdrs = budgetBlockHeaders(err);
    expect(hdrs['x-spillway-block-scope-type']).toBe('org');
    expect(hdrs['x-spillway-block-period']).toBe('day');
    // scope_id / spent / limit not present → not emitted
    expect(hdrs['x-spillway-block-scope-id']).toBeUndefined();
    expect(hdrs['x-spillway-block-spent-usd']).toBeUndefined();
  });

  it('guardrailBlockHeaders: always emits block-reason; conditionally emits policy/decision/approval', () => {
    const err = new SpillwayError('rule_deny', 'denied', {
      httpStatus: 403,
      details: { policy_id: 'p1', decision_id: 'd1' },
    });
    const hdrs = guardrailBlockHeaders(err);
    expect(hdrs['x-spillway-block-reason']).toBe('rule_deny');
    expect(hdrs['x-spillway-policy-id']).toBe('p1');
    expect(hdrs['x-spillway-decision-id']).toBe('d1');
    expect(hdrs['x-spillway-approval-request-id']).toBeUndefined();

    // no details → block-reason still emitted, others absent
    const noDetails = new SpillwayError('rule_deny', 'd', { httpStatus: 403 });
    const nh = guardrailBlockHeaders(noDetails);
    expect(nh['x-spillway-block-reason']).toBe('rule_deny');
    expect(nh['x-spillway-policy-id']).toBeUndefined();
  });
});
