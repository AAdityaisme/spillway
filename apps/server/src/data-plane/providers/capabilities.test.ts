import { describe, it, expect } from 'vitest';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import {
  getCapabilities,
  requiredFeatures,
  assertSupported,
  candidateSupports,
} from './registry.js';
import { lookupCapabilities, chatCaps, chatModelDefault } from './capabilities.js';
import {
  CANONICAL_ERROR_CLASS,
  FEATURE_CAP_COLUMN,
  HARD_GATE_FEATURES,
  type Candidate,
  type ErrorClass,
} from './types.js';
import { SpillwayError } from '@spillway/shared';

/**
 * Part III adapter-contract (part-3/01) — the declared-capability catalog + routing façade. Covers the
 * static catalog lookup (exact → prefix → fail-open default), the request→feature analysis, and the
 * hard-gate (unsupported_feature 400, never for uncatalogued models). Pure, no DB/network.
 */

describe('lookupCapabilities', () => {
  const cat = { 'gpt-4o': chatCaps(['tools']), 'gpt-4o-mini': chatCaps(['vision']) };
  it('prefers an exact match, then the LONGEST prefix', () => {
    expect([...lookupCapabilities(cat, 'gpt-4o').features]).toEqual(['tools']);
    expect([...lookupCapabilities(cat, 'gpt-4o-mini-2024').features]).toEqual(['vision']); // longest prefix
    expect([...lookupCapabilities(cat, 'gpt-4o-2024-08-06').features]).toEqual(['tools']); // dated snapshot
  });
  it('falls back to the broad chat default for an unknown model (fail-open)', () => {
    const caps = lookupCapabilities(cat, 'totally-unknown');
    expect(caps.features.has('tools')).toBe(true); // assumed capable, so the gate never false-rejects
    expect(caps).toEqual(chatModelDefault());
  });
});

describe('openai catalog', () => {
  it('gpt-4o supports vision + tools but not reasoning_effort', () => {
    expect(openaiAdapter.supports('gpt-4o', 'vision')).toBe(true);
    expect(openaiAdapter.supports('gpt-4o', 'tools')).toBe(true);
    expect(openaiAdapter.supports('gpt-4o', 'reasoning_effort')).toBe(false);
  });
  it('o-series support reasoning_effort', () => {
    expect(openaiAdapter.supports('o3', 'reasoning_effort')).toBe(true);
  });
  it('embeddings models are the embeddings task only — no chat features', () => {
    const caps = openaiAdapter.capabilitiesFor('text-embedding-3-small');
    expect(caps.tasks).toEqual(['embeddings']);
    expect(openaiAdapter.supports('text-embedding-3-small', 'tools')).toBe(false);
    expect(openaiAdapter.supports('text-embedding-3-small', 'embeddings')).toBe(true);
  });
  it('anthropic 4.x adds reasoning_effort; no native json_mode', () => {
    expect(anthropicAdapter.supports('claude-sonnet-4-6', 'reasoning_effort')).toBe(true);
    expect(anthropicAdapter.supports('claude-3-5-sonnet', 'reasoning_effort')).toBe(false);
    expect(anthropicAdapter.supports('claude-opus-4-8', 'json_mode')).toBe(false);
  });
  it('anthropic does NOT claim structured_output — the transform drops response_format (red-team part-3 #2)', () => {
    // structured_output is a HARD_GATE feature: claiming it would pass the route.ts gate and then
    // SILENTLY drop the schema (anthropic.ts transform strips response_format), returning free-form
    // prose against a schema-constrained parse. The catalog must match the transform's real behavior.
    expect(anthropicAdapter.supports('claude-opus-4-8', 'structured_output')).toBe(false);
    expect(anthropicAdapter.supports('claude-3-5-sonnet', 'structured_output')).toBe(false);
    // Contrast: OpenAI DOES forward response_format verbatim, so its claim is honest.
    expect(openaiAdapter.supports('gpt-4o', 'structured_output')).toBe(true);
  });
});

describe('requiredFeatures', () => {
  it('infers tools / structured_output / vision / streaming from the body', () => {
    expect(requiredFeatures({ tools: [{ type: 'function' }] })).toContain('tools');
    expect(requiredFeatures({ tool_choice: 'required', tools: [{}] })).toContain(
      'tool_choice_required',
    );
    expect(requiredFeatures({ response_format: { type: 'json_schema' } })).toContain(
      'structured_output',
    );
    expect(requiredFeatures({ response_format: { type: 'json_object' } })).toContain('json_mode');
    expect(requiredFeatures({ stream: true })).toContain('streaming');
    expect(
      requiredFeatures({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      }),
    ).toContain('vision');
  });
  it('a plain text chat request needs no semantic feature', () => {
    expect(requiredFeatures({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([]);
  });
});

describe('assertSupported / candidateSupports', () => {
  const embed: Candidate = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    providerKeyId: 'pk',
  };
  const chat: Candidate = { provider: 'openai', model: 'gpt-4o', providerKeyId: 'pk' };

  it('throws unsupported_feature (400) when the model lacks a required hard-gate feature', () => {
    try {
      assertSupported(embed, ['tools']);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SpillwayError);
      expect((e as SpillwayError).code).toBe('unsupported_feature');
      expect((e as SpillwayError).httpStatus).toBe(400);
    }
  });
  it('passes when the model supports every required feature', () => {
    expect(() => assertSupported(chat, ['tools', 'vision'])).not.toThrow();
  });
  it('never gates a NON-semantic feature (streaming) — only hard-gate features gate', () => {
    expect(() => assertSupported(embed, ['streaming'])).not.toThrow();
    expect(candidateSupports(embed, ['streaming'])).toBe(true);
  });
  it('candidateSupports is the skip-not-fail predicate', () => {
    expect(candidateSupports(chat, ['tools', 'vision'])).toBe(true);
    expect(candidateSupports(embed, ['tools'])).toBe(false);
  });
  it('getCapabilities keys off the concrete model', () => {
    expect(getCapabilities('openai', 'gpt-4o').features.has('vision')).toBe(true);
  });
});

describe('vocabulary contracts', () => {
  it('CANONICAL_ERROR_CLASS maps every ErrorClass non-null value to a distinct canonical name', () => {
    const classes: NonNullable<ErrorClass>[] = [
      'rate_limit',
      'context_window',
      'content_policy',
      'client',
      'auth',
      'timeout',
      'server',
    ];
    for (const c of classes) expect(typeof CANONICAL_ERROR_CLASS[c]).toBe('string');
    expect(new Set(Object.values(CANONICAL_ERROR_CLASS)).size).toBe(classes.length); // 1:1, no collisions
  });
  it('every hard-gate feature has a pinned cap_* column (structured_output → cap_structured_output)', () => {
    for (const f of HARD_GATE_FEATURES) {
      // embeddings/batch/audio/tools/vision/structured_output all map; json_mode is code-only.
      if (f === 'json_mode') continue;
      expect(FEATURE_CAP_COLUMN[f], `missing cap column for ${f}`).toBeTruthy();
    }
    expect(FEATURE_CAP_COLUMN.structured_output).toBe('cap_structured_output');
  });
});
