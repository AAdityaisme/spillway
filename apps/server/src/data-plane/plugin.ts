import type { FastifyPluginAsync } from 'fastify';
import type { Dispatcher } from 'undici';
import cors from '@fastify/cors';
import { SpillwayError, openaiErrorBody } from '@spillway/shared';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/client.js';
import { makeEncryptor, type Encryptor } from '../services/encryptor.js';
import { createStreamTaskTracker } from './streaming/task-tracker.js';
import { checkPolicyCacheSingleton } from './singleton-guard.js';
import { BufbuildConditionEvaluator } from './policy/condition-evaluator.js';
import { InMemoryProviderHealthStore } from './health/store.js';
import { InMemorySessionPinStore } from './routing/session-pin.js';
import { BurstTracker } from '../services/alerts/burst.js';
import { circuitBreakerOpen } from '../observability/metrics.js';
import { chatCompletionsRoute } from './routes/chat-completions.js';
import { messagesRoute } from './routes/messages.js';
import { modelsRoute } from './routes/models.js';
import { embeddingsRoute } from './routes/embeddings.js';

/**
 * DATA PLANE (`/v1/*`) — the gateway (02-architecture §1, §3; ADR-003).
 *
 * Hard boundary: NEVER imports the control plane. Shares only `@spillway/shared`
 * and the DB. CORS is permissive (`*`, no credentials) so browser SDK clients from
 * any origin can call the gateway (10-security §5.5).
 *
 * M2 build-out (data-plane/): pipeline/ (context · auth · validate) · providers/
 * (types · openai · registry) · dispatch.ts · reconcile.ts · routes/chat-completions.ts.
 * Phase B = the non-streaming /v1/chat/completions vertical (single openai candidate,
 * no streaming/retry/budget). See docs/plans/m2-phase-b.md + data-plane/README.md.
 */
export interface DataPlaneOptions {
  config?: Config;
  db?: DatabaseClient;
  /** Test seam (05 §11): inject an undici dispatcher; undefined = global fetch. */
  dispatcher?: Dispatcher;
}

export const dataPlanePlugin: FastifyPluginAsync<DataPlaneOptions> = async (fastify, opts) => {
  await fastify.register(cors, { origin: '*', credentials: false });

  // The data plane returns PROVIDER-SHAPED (OpenAI) error JSON — `{error:{message,
  // type,code}}` — NOT the control plane's RFC7807 `{error:{code,message,docs_url}}`.
  // Client SDKs (openai/anthropic) parse the OpenAI shape; sending anything else makes
  // them throw a parse error instead of surfacing our message (02 §6). Hence a SEPARATE
  // error handler here, scoped to /v1 by Fastify plugin encapsulation.
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof SpillwayError) {
      reply.code(error.httpStatus).send(openaiErrorBody(error));
      return;
    }
    request.log.error({ err: error }, 'data-plane error');
    const e = new SpillwayError('internal_error', 'internal server error', { httpStatus: 500 });
    reply.code(500).send(openaiErrorBody(e));
  });

  // Boot/smoke tests build the app with no db/config — register only CORS + the error
  // handler, no routes (mirrors control-plane/plugin.ts). The gateway pipeline + the
  // chat-completions route capture db + encryptor + dispatcher via closure DI — NOT
  // fastify.decorate — to keep the plane boundary + keep stage fns unit-testable.
  if (!opts.config || !opts.db) return;
  // 17 §3.6: the policy cache is per-instance — warn + gauge if running >1 instance.
  checkPolicyCacheSingleton(opts.config.SPILLWAY_INSTANCE_COUNT, fastify.log);
  const encryptor: Encryptor = makeEncryptor(opts.config);
  // Streaming reconciles run fire-and-forget after the response is sent; the tracker + onClose
  // drain lets them finish on SIGTERM instead of being lost mid-write (ADR-033 D6).
  const streamTasks = createStreamTaskTracker();
  fastify.addHook('onClose', () => streamTasks.drain());
  // One CEL evaluator for the process (16 §5): its WeakMap of compiled programs is GC'd with bundles.
  const conditionEvaluator = new BufbuildConditionEvaluator();
  // One cross-request circuit breaker for the process (15 §6; ADR-016 Redis swap later). The state
  // listener mirrors open/closed transitions onto the spillway_circuit_breaker_open gauge so a
  // provider outage is visible on the dashboard, not just in Axiom logs (expanded-audit MED). Split
  // the candidate key on the FIRST ':' — provider is a fixed enum, model may itself contain ':'.
  const healthStore = new InMemoryProviderHealthStore(Date.now, (key, open) => {
    const i = key.indexOf(':');
    const provider = i === -1 ? key : key.slice(0, i);
    const model = i === -1 ? '' : key.slice(i + 1);
    // L49: remove the series on close rather than setting to 0 — .set({},0) keeps the time-series
    // alive forever, accumulating (provider,model) pairs (including typo'd one-offs) unboundedly.
    // .remove() evicts the label-set from the registry so closed breakers don't bloat /metrics.
    if (open) {
      circuitBreakerOpen.set({ provider, model }, 1);
    } else {
      circuitBreakerOpen.remove({ provider, model });
    }
  });
  // Sticky session affinity (15 §4.5): a process-local pin table. Behind the SessionPinStore interface
  // for the ADR-016 Redis swap when the gateway goes multi-instance.
  const sessionPinStore = new InMemorySessionPinStore();
  const burstTracker = new BurstTracker();
  const deps = {
    db: opts.db,
    encryptor,
    conditionEvaluator,
    healthStore,
    sessionPinStore,
    burstTracker,
    dispatcher: opts.dispatcher,
    streamTasks,
  };

  await fastify.register(chatCompletionsRoute, { deps });
  // Native Anthropic-shape entrypoint (06 §2.2b) + the merged model catalog (04 §2.3). Both share
  // the data-plane pipeline/DI + the OpenAI-shaped error boundary registered above.
  await fastify.register(messagesRoute, { deps });
  await fastify.register(modelsRoute, { deps });
  // /v1/embeddings (task #9): embedding traffic that bypasses the gateway under-counts the ledger —
  // this closes the single-source-of-truth hole. Same pipeline, embeddings-shaped VALIDATE/DISPATCH.
  await fastify.register(embeddingsRoute, { deps });
};
