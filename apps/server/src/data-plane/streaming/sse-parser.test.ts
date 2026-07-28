import { describe, it, expect } from 'vitest';
import { SseEventParser } from './sse-parser.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('SseEventParser', () => {
  it('parses whole events framed by blank lines', () => {
    const p = new SseEventParser();
    const evs = p.push(enc('data: {"a":1}\n\ndata: [DONE]\n\n'));
    expect(evs.map((e) => e.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('retains a partial event across chunk boundaries', () => {
    const p = new SseEventParser();
    expect(p.push(enc('data: {"hel'))).toEqual([]); // incomplete → nothing yet
    const evs = p.push(enc('lo":"world"}\n\n'));
    expect(evs.map((e) => e.data)).toEqual(['{"hello":"world"}']);
  });

  it('handles a multibyte UTF-8 codepoint split across two chunks', () => {
    const p = new SseEventParser();
    const bytes = enc('data: "😀"\n\n'); // emoji is 4 bytes
    const cut = 8; // slice mid-emoji
    expect(p.push(bytes.slice(0, cut))).toEqual([]);
    const evs = p.push(bytes.slice(cut));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.data).toBe('"😀"');
  });

  it('handles CRLF delimiters', () => {
    const p = new SseEventParser();
    const evs = p.push(enc('data: {"a":1}\r\n\r\n'));
    expect(evs.map((e) => e.data)).toEqual(['{"a":1}']);
  });

  it('flush() emits a trailing event with no final blank line', () => {
    const p = new SseEventParser();
    expect(p.push(enc('data: {"a":1}'))).toEqual([]); // no terminator
    expect(p.flush().map((e) => e.data)).toEqual(['{"a":1}']);
  });

  it('ignores non-data lines (event:/id:/comments)', () => {
    const p = new SseEventParser();
    const evs = p.push(enc(': ping\nevent: message\ndata: {"a":1}\n\n'));
    expect(evs.map((e) => e.data)).toEqual(['{"a":1}']);
  });

  it('throws past the 2MB buffer cap (hostile/unbounded event)', () => {
    const p = new SseEventParser();
    expect(() => p.push(enc('data: ' + 'x'.repeat(2_100_000)))).toThrow(/buffer cap/);
  });
});
