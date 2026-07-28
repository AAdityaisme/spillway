import { EventEmitter } from 'node:events';

/**
 * Process-local event bus (02-architecture §4). The data-plane policy LRU cache
 * subscribes to invalidation events; the control plane emits them on virtual-key /
 * provider-key / org mutations so a cached policy bundle is dropped within the
 * process. Cross-process invalidation rides the 30s TTL (single-node v1). The
 * control-plane emits are wired in Phase E — listeners are harmless no-ops until then.
 */
export const internalBus = new EventEmitter();
internalBus.setMaxListeners(50);

/** Emitted with the affected key_hash (hex) / org id so the cache can evict precisely. */
export type PolicyInvalidationEvent = { keyHash?: string; orgId?: string };
export const POLICY_INVALIDATED = 'policy.invalidated';
