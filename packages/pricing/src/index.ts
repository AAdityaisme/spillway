/**
 * @spillway/pricing — cost math, price-table types, LiteLLM sync parser, and
 * tokenizer estimation (02-architecture §2, §8).
 *
 * M2 ports `computeCost()` / `normalizeUsage()` from the reference repo
 * (server/services/pricing.js) plus the Appendix D §7 formulas (cache tiers,
 * Gemini 200K long-context tier) and the canonical token semantics in
 * ADR-019(a). M0 ships the decimal-safe money primitive those formulas build on.
 */
export * from './money.js';
export * from './cost.js';
export * from './litellm-sync.js';
export * from './capabilities.js';
