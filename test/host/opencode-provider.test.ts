import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenCodeGoProvider, createOpenCodeProvider } from '../../src/host/provider/opencode.ts';
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
