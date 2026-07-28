import { SpillwayError } from '@spillway/shared';
import { assertSafeBaseUrl } from '../../auth/ssrf.js';
import { openaiAdapter } from './openai.js';
import type {
  Adapter,
  Candidate,
  Capabilities,
  MappedError,
  ParsedUsage,
  RequestFeature,
  StreamParser,
} from './types.js';

/**
 * OpenAI-compatible adapter (06-providers §4). Serves any provider that exposes an
 * OpenAI-shaped chat-completions API — xAI, Mistral, DeepSeek, Groq, Together, Fireworks,
 * self-hosted vLLM, etc. The ONLY differentiator from the OpenAI adapter is the upstream
 * origin: `candidate.baseUrl` (from provider_keys.base_url), which replaces the fixed
 * api.openai.com host (§4.2). Request shaping, usage extraction, streaming, and error
 * mapping are all OpenAI-native, so this adapter reuses the openai adapter for those paths
 * (§4.4/§4.6/§4.7/§4.8) — one implementation, no drift between the two OpenAI-shape upstreams.
 */

/** Build the compat chat-completions URL: strip trailing slash(es) off base_url, append the path
 *  (§4.4). base_url is the host+optional-version-prefix (e.g. https://api.x.ai/v1); we never rewrite
 *  the model or assume a fixed path segment beyond `/chat/completions`. */
function compatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * SSRF re-validation at DISPATCH time (06 §4.3, 10-security §4). `provider_keys.base_url` was
 * validated when written, but an internal IP can become valid between create and use, and a
 * DNS-rebinding attacker can target the create-time check specifically — so the base_url MUST be
 * re-validated on every dispatch, not trusted from config. The dispatcher calls transform() once
 * per candidate attempt, so validating here IS the per-dispatch hook. assertSafeBaseUrl throws a
 * SpillwayError('invalid_request', httpStatus 422) on a non-https / credentialed / private /
 * link-local (incl. 169.254.169.254 metadata) / obfuscated-IP base_url; that throw propagates out of
 * transform and the dispatcher surfaces it (never forwarding the request upstream).
 *
 * No trustedHosts are passed here: dispatch-time validation is deliberately the strict floor — a host
 * allow-listed at write time is not re-trusted blindly at egress.
 *
 * CALLER CONTRACT (integration/dispatch layer, NOT owned by this file): the upstream fetch for an
 * openai_compat candidate MUST set `redirect: 'error'` (Node/undici) so a 3xx to an internal host
 * cannot bypass this check post-DNS (§4.3 "zero redirects" → SSRF_REDIRECT_BLOCKED). transform cannot
 * enforce that from the returned TransformResult; it is asserted at the fetch site.
 */
export const openaiCompatAdapter: Adapter = {
  provider: 'openai_compat',

  transform(body, candidate: Candidate, decryptedKey, opts) {
    const baseUrl = candidate.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      // A missing base_url is a config fault for THIS candidate, not a client error. Mirrors the
      // shape assertSafeBaseUrl throws so the dispatcher handles both identically.
      throw new SpillwayError('invalid_request', 'openai_compat candidate is missing base_url', {
        httpStatus: 422,
      });
    }
    assertSafeBaseUrl(baseUrl); // throws on an unsafe base_url — see the doc comment above

    // Request shaping is identical to OpenAI (§4.4): system prepend, max_completion_tokens rename,
    // param validation, strip-and-record, and stream_options.include_usage injection all apply
    // unchanged. Reuse the openai transform, then point it at the compat origin.
    const shaped = openaiAdapter.transform(body, candidate, decryptedKey, opts);
    return { ...shaped, url: compatUrl(baseUrl) };
  },

  transformEmbeddings(body, candidate: Candidate, decryptedKey) {
    const baseUrl = candidate.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new SpillwayError('invalid_request', 'openai_compat candidate is missing base_url', {
        httpStatus: 422,
      });
    }
    assertSafeBaseUrl(baseUrl); // same dispatch-time SSRF floor as chat (§4.3)
    const shaped = openaiAdapter.transformEmbeddings!(body, candidate, decryptedKey);
    return { ...shaped, url: `${baseUrl.replace(/\/+$/, '')}/embeddings` };
  },

  // OpenAI response shape (§4.7) — same usage mapping (cached-token subtraction, int32 clamp, null on
  // absent/zero). reasoning_tokens read from completion_tokens_details.reasoning_tokens if present.
  parseBody(responseBody, candidate?: Candidate, requestBody?: unknown): ParsedUsage | null {
    return openaiAdapter.parseBody(responseBody, candidate, requestBody);
  },

  // OpenAI-shaped SSE (§4.6). Degradation Rule 1 (upstream ignored stream_options.include_usage → no
  // usage chunk) is already handled by the openai parser's estimator fallback (usage_estimated=true).
  createStreamParser(candidate: Candidate): StreamParser {
    return openaiAdapter.createStreamParser(candidate);
  },

  // OpenAI error taxonomy (§4.8 mirrors §1.6). SSRF_BLOCKED / SSRF_REDIRECT_BLOCKED are surfaced by
  // the thrown SpillwayError in transform and the fetch-site redirect guard — not by mapError, which
  // only classifies an actual upstream HTTP status.
  mapError(httpStatus: number, body: unknown): MappedError {
    return openaiAdapter.mapError(httpStatus, body);
  },

  // A compat model is an arbitrary OpenAI-shaped endpoint (llama/mistral/…); its id won't match the
  // OpenAI catalog, so this resolves to the fail-open chat default — an uncatalogued compat model is
  // assumed capable (never hard-gated). Registering a real catalog per base_url is a follow-up.
  capabilitiesFor(model: string): Capabilities {
    return openaiAdapter.capabilitiesFor(model);
  },
  supports(model: string, feature: RequestFeature): boolean {
    return openaiAdapter.supports(model, feature);
  },
};
