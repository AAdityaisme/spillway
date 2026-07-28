import { describe, it, expect } from 'vitest';
import { estimateTokensFromText, estimateInputTokens } from './estimator.js';

describe('estimateTokensFromText', () => {
  it('is chars/4 for a factor-1.0 model, ceil', () => {
    expect(estimateTokensFromText('12345678', 'gpt-4.1')).toBe(2); // 8/4
    expect(estimateTokensFromText('123456789', 'gpt-4.1')).toBe(3); // ceil(9/4)
  });
  it('returns 0 for empty / non-string', () => {
    expect(estimateTokensFromText('', 'gpt-4.1')).toBe(0);
    expect(estimateTokensFromText(undefined as unknown as string, 'gpt-4.1')).toBe(0);
  });
  it('falls back to factor 1.0 for an unknown model', () => {
    expect(estimateTokensFromText('12345678', 'some-unknown-model')).toBe(2);
  });
});

describe('estimateInputTokens', () => {
  it('counts string message content + top-level system', () => {
    const body = {
      messages: [{ role: 'user', content: '12345678' }], // 8 chars → 2
      system: '1234', // 4 chars → +1
    };
    expect(estimateInputTokens(body, 'gpt-4.1')).toBe(3); // ceil((8+4)/4)
  });
  it('counts text parts + a flat floor per image part (vision → not $0, red-team)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '1234' },
            { type: 'image_url', image_url: {} },
          ],
        },
      ],
    };
    expect(estimateInputTokens(body, 'gpt-4.1')).toBe(1 + 765); // ceil(4/4) + IMAGE_TOKEN_FLOOR
  });

  it('a vision-only request (no text) still estimates > 0 (never $0 on disconnect)', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] };
    expect(estimateInputTokens(body, 'gpt-4.1')).toBe(765);
  });
  it('never throws on a malformed body → 0', () => {
    expect(estimateInputTokens(null, 'gpt-4.1')).toBe(0);
    expect(estimateInputTokens({ messages: 'nope' }, 'gpt-4.1')).toBe(0);
    expect(estimateInputTokens(42, 'gpt-4.1')).toBe(0);
  });
});

describe('estimateInputTokens — embeddings input (task #9)', () => {
  it('counts a string input (was 0 → free under TPM/budget)', () => {
    expect(estimateInputTokens({ input: 'abcdefgh' }, 'text-embedding-3-small')).toBeGreaterThan(0);
  });
  it('counts an array input via its JSON size', () => {
    const est = estimateInputTokens({ input: ['abcd', 'efgh'] }, 'text-embedding-3-small');
    expect(est).toBeGreaterThan(0);
  });
  it('input and messages accumulate independently (no cross-shape interference)', () => {
    const chatOnly = estimateInputTokens(
      { messages: [{ role: 'user', content: 'abcdefgh' }] },
      'gpt-4.1',
    );
    const withInput = estimateInputTokens(
      { messages: [{ role: 'user', content: 'abcdefgh' }], input: 'abcdefgh' },
      'gpt-4.1',
    );
    expect(withInput).toBeGreaterThan(chatOnly);
  });
});

describe('estimateInputTokens — token-array inputs count 1:1 (red-team task #9)', () => {
  it('number[] input: each element IS a token (JSON-length/4 undercounted ~2x)', () => {
    const input = Array(8191).fill(0);
    expect(estimateInputTokens({ input }, 'text-embedding-3-small')).toBe(8191);
  });
  it('number[][] batch input: sums row lengths', () => {
    const input = [Array(100).fill(1), Array(50).fill(2)];
    expect(estimateInputTokens({ input }, 'text-embedding-3-small')).toBe(150);
  });
});
