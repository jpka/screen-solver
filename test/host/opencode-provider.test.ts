import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenCodeGoProvider, createOpenCodeProvider } from '../../src/host/provider/opencode.ts';
import { createOpenRouterProvider } from '../../src/host/provider/openrouter.ts';
import { createGeminiProvider } from '../../src/host/provider/gemini.ts';
import type { SolveEvent, SolveImage } from '../../src/host/provider/types.ts';
import { createSecret } from '../../src/host/secret.ts';

const IMAGE: SolveImage = { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

function sse(...events: readonly object[]): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(iterable: AsyncIterable<SolveEvent>): Promise<SolveEvent[]> {
  const events: SolveEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createOpenCodeProvider', () => {
  it('uses Responses streaming with the selected model, image, and transcript', async () => {
    let request: RequestInit | undefined;
    const provider = createOpenCodeProvider({
      apiKey: createSecret('opencode-test-key'),
      systemPrompt: 'Solve it.',
      models: [{ id: 'm-fast', name: 'Fast' }, { id: 'm-careful', name: 'Careful' }],
      model: 'm-fast',
      fetch: async (_url, init) => {
        request = init;
        return sse(
          { type: 'response.output_text.delta', delta: '# Answer\n' },
          { type: 'response.output_text.delta', delta: 'done' },
          { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } } },
        );
      },
    });

    const events = await collect(provider.solve(IMAGE, { model: 'm-careful', transcript: 'What is this?' }));
    assert.deepEqual(events, [
      { type: 'delta', text: '# Answer\n' },
      { type: 'delta', text: 'done' },
      { type: 'done', stopReason: 'completed', usage: { inputTokens: 12, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 3 } },
    ]);
    assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer opencode-test-key');
    const body = JSON.parse(String(request?.body)) as { model: string; instructions: string; input: Array<{ content: Array<Record<string, string>> }> };
    assert.equal(body.model, 'm-careful');
    assert.equal(body.instructions, 'Solve it.');
    assert.deepEqual(body.input[0]?.content, [
      { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' },
      { type: 'input_text', text: '<recent_transcript>\nWhat is this?\n</recent_transcript>' },
    ]);
  });

  it('classifies an authorization failure without exposing the key', async () => {
    const provider = createOpenCodeProvider({
      apiKey: createSecret('never-log-me'),
      systemPrompt: 'Solve it.',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    });
    assert.deepEqual(await collect(provider.solve(IMAGE)), [{ type: 'error', kind: 'auth', message: 'bad key' }]);
  });

  it('does not mark a partial answer complete when OpenCode reports an incomplete response', async () => {
    const provider = createOpenCodeProvider({
      apiKey: createSecret('opencode-test-key'),
      systemPrompt: 'Solve it.',
      fetch: async () => sse(
        { type: 'response.output_text.delta', delta: 'partial answer' },
        { type: 'response.incomplete', error: { message: 'generation stopped' } },
      ),
    });

    assert.deepEqual(await collect(provider.solve(IMAGE)), [
      { type: 'delta', text: 'partial answer' },
      { type: 'error', kind: 'transient', message: 'generation stopped' },
    ]);
  });

  it('reports a truncated stream instead of completing its partial answer', async () => {
    const provider = createOpenCodeProvider({
      apiKey: createSecret('opencode-test-key'),
      systemPrompt: 'Solve it.',
      fetch: async () => sse({ type: 'response.output_text.delta', delta: 'partial answer' }),
    });

    assert.deepEqual(await collect(provider.solve(IMAGE)), [
      { type: 'delta', text: 'partial answer' },
      { type: 'error', kind: 'transient', message: 'The OpenCode stream ended before the answer was complete.' },
    ]);
  });

  it('uses Go’s distinct endpoint catalog and stable session header', async () => {
    let url = '';
    let headers: Record<string, string> | undefined;
    const provider = createOpenCodeGoProvider({
      apiKey: createSecret('go-key'),
      systemPrompt: 'Solve it.',
      sessionId: 'screen-solver-session',
      fetch: async (nextUrl, init) => {
        url = String(nextUrl);
        headers = init?.headers as Record<string, string> | undefined;
        return sse({ type: 'response.completed', response: { usage: {} } });
      },
    });
    await collect(provider.solve(IMAGE));
    assert.equal(url, 'https://opencode.ai/zen/go/v1/responses');
    assert.equal((headers as Record<string, string>)['x-opencode-session'], 'screen-solver-session');
    assert.equal(provider.model, 'gpt-5.6-luna');
    assert.equal(provider.models?.some((choice) => choice.id === 'gpt-6-luna'), true);
  });
});

describe('OpenRouter and Gemini providers', () => {
  it('sends OpenRouter an OpenAI-compatible multimodal request and maps stream chunks', async () => {
    let body = '';
    const provider = createOpenRouterProvider({
      apiKey: createSecret('router-key'), systemPrompt: 'Solve it.',
      fetch: async (_url, init) => {
        body = String(init?.body);
        return sse(
          { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
        );
      },
    });
    const events = await collect(provider.solve(IMAGE));
    assert.equal(events[0]?.type, 'delta');
    assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'stop', usage: { inputTokens: 8, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } });
    assert.match(body, /image_url/);
    assert.match(body, /data:image\/png;base64,AQID/);
  });

  it('sends Gemini inline image data and maps its stream and usage metadata', async () => {
    let url = '';
    let body = '';
    const provider = createGeminiProvider({
      apiKey: createSecret('gemini-key'), systemPrompt: 'Solve it.',
      fetch: async (nextUrl, init) => {
        url = String(nextUrl); body = String(init?.body);
        return sse({ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, cachedContentTokenCount: 2 } });
      },
    });
    const events = await collect(provider.solve(IMAGE));
    assert.equal(url.includes(':streamGenerateContent?alt=sse'), true);
    assert.match(body, /inlineData/);
    assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'STOP', usage: { inputTokens: 9, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 2 } });
  });
});
