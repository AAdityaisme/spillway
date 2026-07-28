/**
 * @spillway/shared — single source of truth for cross-plane types, zod schemas,
 * and the error taxonomy (02-architecture §3, §6). The data plane and control
 * plane never import each other; they share only this package and the DB.
 *
 * M1 adds the zod request/response contract schemas (04-api-contracts §1).
 */
export * from './errors.js';
export * from './events.js';
export * from './schemas/control-plane.js';
export * from './schemas/data-plane.js';
export * from './schemas/governance.js';
