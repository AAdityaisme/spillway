import { describe, it, expect } from 'vitest';
import { residencyAllows } from './residency.js';

/**
 * part-3/02 residency compatibility matrix. Follows the chapter's detailed matrix (its §"compatibility
 * matrix"), which is self-consistent: `global` is the universal baseline every non-strict class also
 * reaches; fedramp/hipaa are STRICT (no global fallback); an unknown class fails closed to global-only.
 * (The chapter's one-line "us_only cannot route to global" aside contradicts its own matrix; the matrix
 * wins — documented here so the divergence is a decision, not a silent drift.)
 */
describe('residencyAllows', () => {
  it('none (default) reaches ONLY global', () => {
    expect(residencyAllows('none', 'global')).toBe(true);
    expect(residencyAllows('none', 'us_only')).toBe(false);
    expect(residencyAllows('none', 'eu_only')).toBe(false);
  });
  it('us_only reaches global + us_only, but not eu_only', () => {
    expect(residencyAllows('us_only', 'global')).toBe(true);
    expect(residencyAllows('us_only', 'us_only')).toBe(true);
    expect(residencyAllows('us_only', 'eu_only')).toBe(false);
  });
  it('eu_only reaches global + eu_only, but not us_only', () => {
    expect(residencyAllows('eu_only', 'eu_only')).toBe(true);
    expect(residencyAllows('eu_only', 'us_only')).toBe(false);
  });
  it('fedramp / hipaa are STRICT — no global fallback', () => {
    expect(residencyAllows('fedramp', 'fedramp')).toBe(true);
    expect(residencyAllows('fedramp', 'global')).toBe(false);
    expect(residencyAllows('hipaa', 'hipaa_eligible')).toBe(true);
    expect(residencyAllows('hipaa', 'global')).toBe(false);
  });
  it('an unknown compliance class fails closed to global-only', () => {
    expect(residencyAllows('bogus', 'global')).toBe(true);
    expect(residencyAllows('bogus', 'us_only')).toBe(false);
  });
});
