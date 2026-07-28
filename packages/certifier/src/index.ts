/**
 * @spillway/certifier — model-capability certification (part-3/06). The DECLARED_CAPS matrix (single
 * source of truth for router/catalog/smoke), plus the pure smoke-runner orchestration (budget cap,
 * transient retry, result bookkeeping). Live provider calls + DB writes are wired in the nightly CI job.
 */
export * from './matrix.js';
export * from './smoke.js';
export * from './fixture.js';
