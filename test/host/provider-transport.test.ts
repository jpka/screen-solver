import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANTHROPIC_VERSION,
  AnthropicApiError,
  AnthropicNetworkError,
  createFetchTransport,
  parseServerSentEvents,
  type AnthropicStreamEvent,
  type MessagesRequest,
} from '../../src/host/provider/transport.ts';
import { createSecret } from '../../src/host/secret.ts';

const API_KEY = 'sk-ant-test-transport';

const BODY: MessagesRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 8000,
  stream: true,
  system: [{ type: 'text', text: 'prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
  ],
  output_config: { effort: 'medium' },
};

function bytes(text: string): AsyncGenerator<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(text);
  })();
}

/** A response body split at the exact chunk boundaries the caller names. */
function chunkedSse(chunks: string | readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = typeof chunks === 'string' ? [chunks] : chunks;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of parts) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function drain(stream: AsyncIterable<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('parseServerSentEvents', () => {
  it('reads one payload per blank-line-terminated block', async () => {
    const events = await drain(
      parseServerSentEvents(
        bytes(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      ),
    );

    assert.deepEqual(events, [{ type: 'message_start' }, { type: 'message_stop' }]);
  });

  it('reassembles events split across chunk boundaries', async () => {
    const source = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"type":"content_bl');
      yield encoder.encode('ock_delta","delta":{"type":"text_delta","text":"héllo"}}\n');
      yield encoder.encode('\ndata: {"type":"message_stop"}\n\n');
    })();

    const events = await drain(parseServerSentEvents(source));

    assert.equal(events.length, 2);
    assert.equal(events[0]?.delta?.text, 'héllo');
  });

  it('ignores comments and CRLF framing, and tolerates a missing final blank line', async () => {
    const events = await drain(
      parseServerSentEvents(bytes(': ping\r\n\r\ndata: {"type":"message_stop"}\r\n')),
    );

    assert.deepEqual(events, [{ type: 'message_stop' }]);
  });

  it('reports malformed payloads as a retryable network failure', async () => {
    await assert.rejects(
      () => drain(parseServerSentEvents(bytes('data: {not json}\n\n'))),
      AnthropicNetworkError,
    );
  });
});

describe('createFetchTransport', () => {
  it('posts the body to /v1/messages with the auth and version headers', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      fetch: async (url, init) => {
        seen.url = String(url);
        seen.init = init;
        return new Response(chunkedSse('data: {"type":"message_stop"}\n\n'), { status: 200 });
      },
    });

    const events = await drain(transport({ body: BODY, signal: undefined }));

    assert.deepEqual(events, [{ type: 'message_stop' }]);
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen.init?.method, 'POST');
    const headers = seen.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], API_KEY);
    assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(seen.init?.body)), BODY);
  });

  it('honours an overridden base url without doubling the slash', async () => {
    let url = '';
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      baseUrl: 'http://127.0.0.1:9999/',
      fetch: async (requested) => {
        url = String(requested);
        return new Response(chunkedSse('data: {"type":"message_stop"}\n\n'), { status: 200 });
      },
    });

    await drain(transport({ body: BODY, signal: undefined }));

    assert.equal(url, 'http://127.0.0.1:9999/v1/messages');
  });

  it('turns a non-2xx response into an AnthropicApiError carrying status and type', async () => {
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status: 401 },
        ),
    });

    await assert.rejects(
      () => drain(transport({ body: BODY, signal: undefined })),
      (error: unknown) => {
        assert.ok(error instanceof AnthropicApiError);
        assert.equal(error.status, 401);
        assert.equal(error.errorType, 'authentication_error');
        assert.equal(error.message, 'invalid x-api-key');
        return true;
      },
    );
  });

  it('falls back to the status when the error body is not JSON', async () => {
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      fetch: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });

    await assert.rejects(
      () => drain(transport({ body: BODY, signal: undefined })),
      (error: unknown) => {
        assert.ok(error instanceof AnthropicApiError);
        assert.equal(error.status, 502);
        return true;
      },
    );
  });

  it('turns a failed connection into an AnthropicNetworkError', async () => {
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await assert.rejects(
      () => drain(transport({ body: BODY, signal: undefined })),
      (error: unknown) => {
        assert.ok(error instanceof AnthropicNetworkError);
        assert.match(error.message, /api\.anthropic\.com/);
        return true;
      },
    );
  });

  it('never puts the key anywhere but the x-api-key header', async () => {
    let init: RequestInit | undefined;
    const transport = createFetchTransport({
      apiKey: createSecret(API_KEY),
      fetch: async (url, requestInit) => {
        init = requestInit;
        assert.equal(String(url).includes(API_KEY), false);
        return new Response(chunkedSse('data: {"type":"message_stop"}\n\n'), { status: 200 });
      },
    });

    await drain(transport({ body: BODY, signal: undefined }));

    assert.equal(String(init?.body).includes(API_KEY), false);
  });
});
