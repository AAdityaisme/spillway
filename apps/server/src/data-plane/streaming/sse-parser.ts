import type { SseEvent } from '../providers/types.js';

/**
 * Incremental SSE parser (05-gateway-core §7). Feed it raw upstream bytes as they arrive;
 * it emits complete SSE events and retains any partial trailing fragment across reads.
 *
 * Correctness landmines this handles (all from the Phase C red-team / m2-gateway notes):
 *  - CHUNK BOUNDARIES: an event can split across TCP reads, and a multibyte UTF-8 codepoint
 *    can split across reads — a single streaming TextDecoder buffers the partial codepoint.
 *    (The tee forwards RAW bytes to the client byte-for-byte; only THIS parser copy decodes.)
 *  - TRAILING EVENT: if the upstream ends without a final blank line, flush() parses the tail
 *    (OpenAI's terminal `data: [DONE]` and the usage chunk before it must not be stranded).
 *  - HOSTILE SIZE: tool-call JSON / base64 images make single events ~2MB; a buggy/hostile
 *    upstream could grow the buffer unbounded → hard cap → throw (the tee treats this as a
 *    fatal stream error and falls back to estimation, never OOMs).
 *
 * This parser NEVER re-serializes client bytes — it only reads a copy to locate the usage
 * frame. Event = a block delimited by a blank line (LF or CRLF); within a block, `data:` lines
 * are concatenated (SSE multi-line data), other fields (event:/id:/retry:/:comment) ignored.
 */
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const EVENT_DELIMITER = /\r?\n\r?\n/;

export class SseEventParser {
  private buf = '';
  private readonly decoder = new TextDecoder('utf-8');

  /** Decode + append a raw chunk; return any newly-complete events. Throws past the 2MB cap. */
  push(chunk: Uint8Array): SseEvent[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    if (this.buf.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error(`SSE event exceeds ${MAX_SSE_BUFFER_BYTES}-byte buffer cap`);
    }
    return this.drain(false);
  }

  /** Flush at upstream end: emit any trailing event that lacked a final blank line. */
  flush(): SseEvent[] {
    this.buf += this.decoder.decode(); // drain any pending multibyte tail
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const m = EVENT_DELIMITER.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    if (final && this.buf.trim().length > 0) {
      const ev = parseBlock(this.buf);
      if (ev) events.push(ev);
      this.buf = '';
    }
    return events;
  }
}

function parseBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    // event: / id: / retry: / :comment lines carry no usage — ignored
  }
  if (dataLines.length === 0) return null;
  return { data: dataLines.join('\n') };
}
