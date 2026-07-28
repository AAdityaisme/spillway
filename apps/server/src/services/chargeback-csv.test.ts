import { describe, it, expect } from 'vitest';
import { statementToCsv, type ChargebackStatement } from './chargeback.js';

/** A one-line statement whose single scope_id is client-controlled (group_by=model → the model name). */
const stmt = (scopeId: string): ChargebackStatement => ({
  orgId: 'org',
  periodStart: '2026-06-01T00:00:00.000Z',
  periodEnd: '2026-07-01T00:00:00.000Z',
  groupBy: 'model',
  lines: [
    {
      scopeType: 'model',
      scopeId,
      requestCount: 1,
      successCount: 1,
      blockedCount: 0,
      costUsd: '1.000000',
    },
  ],
  totalCostUsd: '1.000000',
  reconciliation: {
    requestsUsd: '1.000000',
    attemptsUsd: '1.000000',
    consistent: true,
    countersUsd: null,
    counterConsistent: null,
  },
});

describe('statementToCsv — injection-safe export (expanded-audit HIGH)', () => {
  it('neutralizes a leading formula trigger in a client-controlled model name', () => {
    const csv = statementToCsv(stmt('=HYPERLINK("http://evil","pwned")'));
    expect(csv).toContain(`'=HYPERLINK`); // single-quote prefixed → Excel/Sheets treat it as text
    expect(csv).not.toMatch(/(^|\n)=HYPERLINK/); // never emitted raw at a field/line start
  });

  it('neutralizes +, -, @ formula triggers too', () => {
    for (const trigger of ['+1+1', '-2+3', '@SUM(A1)']) {
      const csv = statementToCsv(stmt(trigger));
      expect(csv).toContain(`'${trigger}`);
    }
  });

  it('RFC-4180 quotes fields containing commas / quotes / newlines', () => {
    expect(statementToCsv(stmt('a,b'))).toContain('"a,b"');
    expect(statementToCsv(stmt('a"b'))).toContain('"a""b"'); // internal quote doubled
    expect(statementToCsv(stmt('a\r\nb'))).toContain('"a\r\nb"');
  });

  it('leaves a benign model name and the numeric columns untouched', () => {
    const csv = statementToCsv(stmt('gpt-4o'));
    expect(csv).toContain('\nmodel,gpt-4o,1,1,0,1.000000\n');
  });

  it('total row carries request/success/blocked subtotals (audit L42/M40)', () => {
    const s: ChargebackStatement = {
      orgId: 'org',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      groupBy: 'team',
      lines: [
        {
          scopeType: 'team',
          scopeId: 't1',
          requestCount: 5,
          successCount: 3,
          blockedCount: 2,
          costUsd: '0.030000',
        },
        {
          scopeType: 'team',
          scopeId: 't2',
          requestCount: 4,
          successCount: 4,
          blockedCount: 0,
          costUsd: '0.020000',
        },
      ],
      totalCostUsd: '0.050000',
      reconciliation: {
        requestsUsd: '0.050000',
        attemptsUsd: '0.050000',
        consistent: true,
        countersUsd: null,
        counterConsistent: null,
      },
    };
    const lines = statementToCsv(s).trim().split('\n');
    expect(lines[0]).toBe('scope_type,scope_id,request_count,success_count,blocked_count,cost_usd');
    // Σreq=9, Σsuccess=7, Σblocked=2 — every numeric column now reconciles, not just request_count.
    expect(lines[lines.length - 1]).toBe('total,,9,7,2,0.050000');
  });
});
