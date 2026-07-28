import { describe, it, expect } from 'vitest';
import {
  createBudgetSchema,
  createAliasSchema,
  createRoutingRuleSchema,
  createPolicySchema,
  createAlertSchema,
  createAutomationRuleSchema,
} from './governance.js';

describe('governance CRUD schemas (B6.0)', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('budget: valid block budget; fallback requires an alias', () => {
    expect(
      createBudgetSchema.safeParse({
        scopeType: 'org',
        scopeId: uuid,
        period: 'day',
        limitUsd: '100.500000',
      }).success,
    ).toBe(true);
    // on_exceed=fallback WITHOUT a fallback_alias → rejected
    expect(
      createBudgetSchema.safeParse({
        scopeType: 'org',
        scopeId: uuid,
        period: 'day',
        limitUsd: '100',
        onExceed: 'fallback',
      }).success,
    ).toBe(false);
    // with the alias → ok
    expect(
      createBudgetSchema.safeParse({
        scopeType: 'org',
        scopeId: uuid,
        period: 'day',
        limitUsd: '100',
        onExceed: 'fallback',
        fallbackAlias: 'cheap',
      }).success,
    ).toBe(true);
    // non-numeric limit + reserved 'customer' scope → rejected
    expect(
      createBudgetSchema.safeParse({
        scopeType: 'org',
        scopeId: uuid,
        period: 'day',
        limitUsd: 'lots',
      }).success,
    ).toBe(false);
    expect(
      createBudgetSchema.safeParse({
        scopeType: 'customer',
        scopeId: uuid,
        period: 'day',
        limitUsd: '1',
      }).success,
    ).toBe(false);
  });

  it('alias: flat + typed-chain both parse', () => {
    expect(
      createAliasSchema.safeParse({
        alias: 'fast',
        targets: [{ provider: 'openai', model: 'gpt-4o' }],
      }).success,
    ).toBe(true);
    expect(
      createAliasSchema.safeParse({
        alias: 'ctx',
        targets: {
          default: [{ provider: 'openai', model: 'gpt-4o' }],
          context_window: [{ provider: 'openai', model: 'gpt-4o-mini' }],
        },
      }).success,
    ).toBe(true);
  });

  it('routing rule: rewrite_model ok; deny is NOT a routing action (ADR-034)', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        priority: 10,
        match: { models: ['gpt-4o'] },
        action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o-mini' } },
      }).success,
    ).toBe(true);
    expect(
      createRoutingRuleSchema.safeParse({
        priority: 10,
        match: {},
        action: { type: 'deny', reason: 'nope' },
      }).success,
    ).toBe(false); // deny not in the discriminated union
  });

  it('policy: valid guardrail; bad effect rejected', () => {
    expect(
      createPolicySchema.safeParse({
        name: 'block-5.5',
        effect: 'deny',
        reason: 'blocked',
        match: { models: ['gpt-5.5'] },
      }).success,
    ).toBe(true);
    expect(createPolicySchema.safeParse({ name: 'x', effect: 'nuke', reason: 'r' }).success).toBe(
      false,
    );
  });

  it('alert: valid', () => {
    expect(
      createAlertSchema.safeParse({ name: 'budget', kind: 'budget_threshold', channels: [] })
        .success,
    ).toBe(true);
  });
});

// M48: safeName guard on governance name fields.
describe('governance schemas — C0 control-char guard in names (M48)', () => {
  it('createAliasSchema rejects an alias name with a newline', () => {
    expect(
      createAliasSchema.safeParse({
        alias: 'fast\nalias',
        targets: [{ provider: 'openai', model: 'gpt-4o' }],
      }).success,
    ).toBe(false);
  });

  it('createPolicySchema rejects a policy name with a tab', () => {
    expect(
      createPolicySchema.safeParse({ name: 'block\tmodels', effect: 'deny', reason: 'r' }).success,
    ).toBe(false);
  });

  it('createAlertSchema rejects an alert name with a CR', () => {
    expect(
      createAlertSchema.safeParse({ name: 'alert\rname', kind: 'budget_threshold', channels: [] })
        .success,
    ).toBe(false);
  });

  it('createAutomationRuleSchema rejects a rule name with a control char', () => {
    expect(
      createAutomationRuleSchema.safeParse({
        name: 'rule\x00name',
        priority: 10,
        triggerType: 'budget_crossed',
        action: {},
      }).success,
    ).toBe(false);
  });
});

// L50: ruleMatch id/model arrays must bound per-string length in addition to array length.
describe('createRoutingRuleSchema — ruleMatch per-string bounds (L50)', () => {
  const baseRule = {
    priority: 10,
    match: {},
    action: { type: 'rewrite_model', to: { provider: 'openai', model: 'gpt-4o-mini' } },
  };

  it('accepts ids and models within the per-string bounds', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        ...baseRule,
        match: {
          virtual_key_ids: ['a'.repeat(256)],
          models: ['gpt-4o'],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a virtual_key_id exceeding 256 chars', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        ...baseRule,
        match: { virtual_key_ids: ['a'.repeat(257)] },
      }).success,
    ).toBe(false);
  });

  it('rejects a model string exceeding 128 chars', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        ...baseRule,
        match: { models: ['m'.repeat(129)] },
      }).success,
    ).toBe(false);
  });

  it('rejects a team_id exceeding 256 chars', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        ...baseRule,
        match: { team_ids: ['t'.repeat(257)] },
      }).success,
    ).toBe(false);
  });

  it('still enforces array count limit (max 200)', () => {
    expect(
      createRoutingRuleSchema.safeParse({
        ...baseRule,
        match: { models: Array.from({ length: 201 }, (_, i) => `m${i}`) },
      }).success,
    ).toBe(false);
  });

  it('F3: schedule_cron accepts only @every <n>[smh]; a standard cron is rejected (not silently dead)', () => {
    const base = { name: 'nightly', priority: 1, triggerType: 'schedule_cron', action: {} };
    expect(
      createAutomationRuleSchema.safeParse({ ...base, scheduleCron: '@every 15m' }).success,
    ).toBe(true);
    expect(
      createAutomationRuleSchema.safeParse({ ...base, scheduleCron: '@every 1h' }).success,
    ).toBe(true);
    // A standard cron would be accepted-then-never-fired by the timer engine → must 400 at creation.
    expect(
      createAutomationRuleSchema.safeParse({ ...base, scheduleCron: '0 9 * * *' }).success,
    ).toBe(false);
    expect(
      createAutomationRuleSchema.safeParse({ ...base, scheduleCron: '*/5 * * * *' }).success,
    ).toBe(false);
    // null/absent stays valid (non-schedule triggers).
    expect(createAutomationRuleSchema.safeParse({ ...base, scheduleCron: null }).success).toBe(
      true,
    );
  });
});
