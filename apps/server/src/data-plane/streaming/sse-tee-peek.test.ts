import { describe, it, expect } from 'vitest';
import { sseErrorObject } from './sse-tee.js';

/**
 * 15 §7.2 first-chunk error classifier — decides whether the first SSE event on a 2xx stream is an
 * in-band error frame (→ advance the chain) or a normal frame (→ commit + stream). Must recognise both
 * provider shapes and never mistake a normal delta / [DONE] / keep-alive for an error.
 */
describe('sseErrorObject', () => {
  it('detects an OpenAI-shaped in-stream error frame', () => {
    const err = sseErrorObject(
      JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }),
    );
    expect(err).toMatchObject({ type: 'server_error' });
  });

  it('detects an Anthropic-shaped error frame ({type:"error", error:{…}})', () => {
    const err = sseErrorObject(
      JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    );
    expect(err).toMatchObject({ type: 'overloaded_error' });
  });

  it('returns null for a normal content delta', () => {
    expect(sseErrorObject(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))).toBeNull();
  });

  it('returns null for [DONE], keep-alive comments, and non-JSON', () => {
    expect(sseErrorObject('[DONE]')).toBeNull();
    expect(sseErrorObject(': keep-alive')).toBeNull();
    expect(sseErrorObject('not json')).toBeNull();
    expect(sseErrorObject('')).toBeNull();
  });

  it('does not treat a frame with a string field literally named error-ish as an error', () => {
    // Only a top-level `error` OBJECT (or type:"error") counts — a message mentioning "error" is fine.
    expect(
      sseErrorObject(
        JSON.stringify({ choices: [{ delta: { content: 'an error occurred in your code' } }] }),
      ),
    ).toBeNull();
  });
});
