import { describe, it, expect } from 'vitest';
import {
  makeOpenAiToAnthropicSseTranslator,
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  openaiResponseToAnthropic,
} from './translate.js';

type Msg = { role: string; content: unknown; tool_calls?: unknown };
const msgsOf = (b: unknown): Msg[] =>
  (anthropicRequestToOpenAI(b).messages as Msg[] | undefined) ?? [];

describe('translate.ts — M2 red-team fixes', () => {
  it('OpenAI→Anthropic SSE: streams tool calls as tool_use content blocks (CRITICAL)', () => {
    const t = makeOpenAiToAnthropicSseTranslator('claude-x');
    const out = [
      ...t.translate({
        data: JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
                ],
              },
            },
          ],
        }),
      }),
      ...t.translate({
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
        }),
      }),
      ...t.translate({
        data: JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      }),
      ...t.flush(),
    ].join('');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"get_weather"');
    expect(out).toContain('partial_json'); // input_json_delta frames carry the argument fragments
    expect(out).toContain('city'); // the streamed arguments (JSON-string-encoded inside the frame)
    expect(out).toContain('NYC');
    expect(out).toContain('"stop_reason":"tool_use"');
    // content_block_stop must close the tool_use block on flush
    expect(out).toContain('content_block_stop');
  });

  it('OpenAI→Anthropic SSE: carries real input/cache usage into message_delta (not 0)', () => {
    const t = makeOpenAiToAnthropicSseTranslator('claude-x');
    t.translate({
      data: JSON.stringify({ id: 'chatcmpl-2', choices: [{ delta: { content: 'hi' } }] }),
    });
    t.translate({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    });
    const out = t.flush().join('');
    expect(out).toContain('"input_tokens":70'); // 100 total − 30 cache-read
    expect(out).toContain('"output_tokens":20');
    expect(out).toContain('"cache_read_input_tokens":30');
  });

  it('tool_choice {type:"none"} survives translation', () => {
    const r = anthropicRequestToOpenAI({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', input_schema: {} }],
      tool_choice: { type: 'none' },
    });
    expect(r.tool_choice).toBe('none');
  });

  it('thinking blocks are preserved (token weight not dropped)', () => {
    const asst = msgsOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'LONG_REASONING_TEXT', signature: 's' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    }).find((m) => m.role === 'assistant');
    expect(JSON.stringify(asst?.content)).toContain('LONG_REASONING_TEXT');
  });

  it('tool_result messages are ordered BEFORE new user text', () => {
    const msgs = msgsOf({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'r' },
            { type: 'text', text: 'next' },
          ],
        },
      ],
    });
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    const userIdx = msgs.findIndex((m) => m.role === 'user');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(toolIdx);
  });

  it('preserves ALL string metadata keys on the canonical body — governance can match /v1/messages (F1)', () => {
    // Previously only metadata.user_id survived, so a metadata-scoped deny/require_approval/routing rule
    // was silently bypassed by choosing /v1/messages. Now every string key is carried so structuredMatch
    // (req.metadata[k] === v) enforces it; non-string values are dropped (they can't match a string
    // filter — mirrors the OpenAI record(string,string) boundary).
    const r = anthropicRequestToOpenAI({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      metadata: { env: 'prod', tier: 'gold', user_id: 'u1', route: 42 },
    });
    expect(r.metadata).toEqual({ env: 'prod', tier: 'gold', user_id: 'u1' }); // route:42 dropped (non-string)
  });

  it('omits metadata entirely when no string keys are present', () => {
    const r = anthropicRequestToOpenAI({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      metadata: { count: 7 },
    });
    expect(r.metadata).toBeUndefined();
  });

  it('F4: an Anthropic refusal stop_reason → OpenAI finish_reason content_filter (not laundered to stop)', () => {
    const r = anthropicResponseToOpenAI(
      {
        id: 'msg_1',
        model: 'claude-3-5-sonnet',
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'I cannot help with that.' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      'claude-3-5-sonnet',
    );
    const choices = r.choices as { finish_reason: string }[];
    expect(choices[0]!.finish_reason).toBe('content_filter');
  });

  it('F5: an OpenAI content_filter finish_reason → Anthropic stop_reason refusal (not end_turn)', () => {
    const r = openaiResponseToAnthropic(
      {
        id: 'chatcmpl_1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'x' },
            finish_reason: 'content_filter',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
      'gpt-4o',
    );
    expect(r.stop_reason).toBe('refusal');
  });
});
