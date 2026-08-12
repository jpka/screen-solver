import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  SYSTEM_PROMPT_CACHE_TTL,
  createProvider,
  type ProviderConfig,
} from '../../src/host/provider/anthropic.ts';
import {
  AnthropicApiError,
  AnthropicNetworkError,
  type AnthropicStreamEvent,
  type AnthropicTransport,
  type MessagesRequest,
} from '../../src/host/provider/transport.ts';
import type { SolveEvent, SolveImage } from '../../src/host/provider/types.ts';
import { createSecret } from '../../src/host/secret.ts';

const SYSTEM_PROMPT = 'You are the solving engine inside Screen Solver.\nAnswer with a heading.';
const IMAGE: SolveImage = { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]) };

/** One scripted transport call: either a canned stream or a canned failure. */
type Attempt = () => AsyncIterable<AnthropicStreamEvent>;

interface Fake {
  readonly transport: AnthropicTransport;
  /** The bodies actually put on the wire, one per attempt. */
  readonly requests: MessagesRequest[];
  readonly calls: () => number;
}

function fakeTransport(attempts: readonly Attempt[]): Fake {
  const requests: MessagesRequest[] = [];

  const transport: AnthropicTransport = (request) => {
    const index = requests.length;
    requests.push(request.body);
    const attempt = attempts[index];
    if (attempt === undefined) {
      throw new Error(`transport called ${index + 1} times; the test scripted ${attempts.length}`);
    }
    return attempt();
  };

  return { transport, requests, calls: () => requests.length };
}

function answer(chunks: readonly string[], stopReason = 'end_turn'): Attempt {
  return async function* () {
    yield {
      type: 'message_start',
      message: {
        usage: { input_tokens: 1420, cache_creation_input_tokens: 0, cache_read_input_tokens: 1300 },
      },
    };
    yield { type: 'content_block_start' };
    // Thinking rides the same event type as answer text and must not leak.
    yield { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'hmm, a kata' } };
    for (const text of chunks) {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
    }
    yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 287 } };
    yield { type: 'message_stop' };
  };
}

function throwing(error: unknown): Attempt {
  return async function* () {
    throw error;
  };
}

function provider(fake: Fake, overrides: Partial<ProviderConfig> = {}) {
  return createProvider({
    apiKey: createSecret('sk-ant-test-provider'),
    systemPrompt: SYSTEM_PROMPT,
    transport: fake.transport,
    // Retries stay configured everywhere, so "no retry attempted" means the
    // taxonomy suppressed it rather than the policy being absent.
    retryDelaysMs: [0, 0],
    ...overrides,
  });
}

async function collect(events: AsyncIterable<SolveEvent>): Promise<SolveEvent[]> {
  const collected: SolveEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function texts(events: readonly SolveEvent[]): string {
  return events
    .filter((event) => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

describe('createProvider().solve', () => {
  it('streams deltas and finishes with a done carrying usage', async () => {
    const fake = fakeTransport([answer(['# Sum\n', '```js\n', 'code\n', '```'])]);

    const events = await collect(provider(fake).solve(IMAGE));

    assert.equal(texts(events), '# Sum\n```js\ncode\n```');
    const terminal = events.at(-1);
    assert.ok(terminal !== undefined && terminal.type === 'done');
    assert.deepEqual(terminal.usage, {
      inputTokens: 1420,
      outputTokens: 287,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1300,
    });
    assert.equal(terminal.stopReason, 'end_turn');
    assert.equal(
      events.filter((event) => event.type === 'done' || event.type === 'error').length,
      1,
      'exactly one terminal event, and it is last',
    );
    assert.equal(fake.calls(), 1);
  });

  it('never lets thinking text reach the answer', async () => {
    const fake = fakeTransport([answer(['visible'])]);

    const events = await collect(provider(fake).solve(IMAGE));

    assert.equal(texts(events), 'visible');
    assert.equal(events.filter((event) => event.type === 'delta').length, 1);
  });

  it('passes a max_tokens stop through so truncation is detectable', async () => {
    const fake = fakeTransport([answer(['half a func'], 'max_tokens')]);

    const events = await collect(provider(fake).solve(IMAGE));

    const terminal = events.at(-1);
    assert.ok(terminal !== undefined && terminal.type === 'done');
    assert.equal(terminal.stopReason, 'max_tokens');
  });

  describe('the request on the wire', () => {
    it('enables prompt caching on the system prompt with a 1h ttl', async () => {
      const fake = fakeTransport([answer(['ok'])]);

      await collect(provider(fake).solve(IMAGE));

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.deepEqual(body.system, [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      assert.equal(SYSTEM_PROMPT_CACHE_TTL, '1h');
    });

    it('carries the configured defaults and the image', async () => {
      const fake = fakeTransport([answer(['ok'])]);

      await collect(provider(fake).solve(IMAGE));

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.equal(body.model, DEFAULT_MODEL);
      assert.equal(body.model, 'claude-sonnet-5');
      assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
      assert.equal(body.max_tokens, 8000);
      assert.deepEqual(body.output_config, { effort: DEFAULT_EFFORT });
      assert.equal(DEFAULT_EFFORT, 'medium');
      assert.equal(body.stream, true);
      assert.deepEqual(body.messages, [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
            },
          ],
        },
      ]);
    });

    it('keeps the system prompt identical across calls, and out of the message turn', async () => {
      const fake = fakeTransport([answer(['a']), answer(['b'])]);
      const seam = provider(fake);

      await collect(seam.solve(IMAGE));
      await collect(seam.solve({ mediaType: 'image/jpeg', bytes: new Uint8Array([9]) }));

      const [first, second] = fake.requests;
      assert.ok(first !== undefined && second !== undefined);
      assert.deepEqual(first.system, second.system, 'a stable prefix is what the cache keys on');
      assert.equal(JSON.stringify(second.messages).includes('Screen Solver'), false);
    });

    it('honours an overridden model, effort, and ceiling', async () => {
      const fake = fakeTransport([answer(['ok'])]);

      await collect(
        provider(fake, { model: 'claude-opus-5', effort: 'high', maxTokens: 2048 }).solve(IMAGE),
      );

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.equal(body.model, 'claude-opus-5');
      assert.deepEqual(body.output_config, { effort: 'high' });
      assert.equal(body.max_tokens, 2048);
    });
  });

  describe('the transcript block', () => {
    it('adds a second content block after the image, wrapped in tags the prompt names', async () => {
      const fake = fakeTransport([answer(['ok'])]);

      await collect(
        provider(fake).solve(IMAGE, { transcript: 'Them: without extra space\nThem: and empty input' }),
      );

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.deepEqual(body.messages, [
        {
          role: 'user',
          content: [
            // Image first: it is what the system prompt names as authoritative.
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } },
            {
              type: 'text',
              text: '<recent_transcript>\nThem: without extra space\nThem: and empty input\n</recent_transcript>',
            },
          ],
        },
      ]);
    });

    it('sends exactly one content block when there is no transcript', async () => {
      const fake = fakeTransport([answer(['ok'])]);

      await collect(provider(fake).solve(IMAGE));

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.equal(body.messages[0]?.content.length, 1);
    });

    it('treats an empty transcript as no transcript rather than an empty block', async () => {
      // An empty `<recent_transcript>` would tell the model speech was captured
      // and there wasn't any -- a different claim from "none is available".
      const fake = fakeTransport([answer(['ok'])]);

      await collect(provider(fake).solve(IMAGE, { transcript: '' }));

      const [body] = fake.requests;
      assert.ok(body !== undefined);
      assert.equal(body.messages[0]?.content.length, 1);
    });

    it('leaves the cached system prefix byte-identical either way', async () => {
      // The prompt-cache regression guard. There is deliberately ONE system
      // prompt, not one per solve flavour: a second prompt would mean a second
      // 1h cache entry, and every alternation between the two client buttons
      // would be a cache MISS on a ~1400-token prefix.
      const fake = fakeTransport([answer(['a']), answer(['b'])]);
      const seam = provider(fake);

      await collect(seam.solve(IMAGE));
      await collect(seam.solve(IMAGE, { transcript: 'Them: hello' }));

      const [plain, withTranscript] = fake.requests;
      assert.ok(plain !== undefined && withTranscript !== undefined);
      assert.equal(JSON.stringify(plain.system), JSON.stringify(withTranscript.system));
      assert.deepEqual(withTranscript.system, [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]);
    });
  });

  describe('failures that must not be retried', () => {
    it('surfaces an auth rejection immediately', async () => {
      const fake = fakeTransport([
        throwing(new AnthropicApiError(401, 'invalid x-api-key', 'authentication_error')),
      ]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.deepEqual(
        events.map((event) => (event.type === 'error' ? event.kind : event.type)),
        ['auth'],
      );
      assert.equal(fake.calls(), 1, 'a revoked key will not un-revoke itself');
    });

    it('treats a 403 as auth too', async () => {
      const fake = fakeTransport([throwing(new AnthropicApiError(403, 'forbidden'))]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.deepEqual(events, [{ type: 'error', kind: 'auth', message: 'forbidden' }]);
      assert.equal(fake.calls(), 1);
    });

    it('surfaces a refusal immediately', async () => {
      const fake = fakeTransport([answer([], 'refusal')]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(events.length, 1);
      assert.ok(events[0] !== undefined && events[0].type === 'error');
      assert.equal(events[0].kind, 'refusal');
      assert.equal(fake.calls(), 1, 'the same screen would be refused again');
    });

    it('does not retry a request the provider called malformed', async () => {
      const fake = fakeTransport([
        throwing(new AnthropicApiError(400, 'max_tokens: must be > 0', 'invalid_request_error')),
      ]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(events.length, 1);
      assert.ok(events[0] !== undefined && events[0].type === 'error');
      assert.equal(events[0].kind, 'transient');
      assert.equal(fake.calls(), 1);
    });
  });

  describe('transient failures', () => {
    it('retries a rate limit and completes normally, with no error on the wire', async () => {
      const fake = fakeTransport([
        throwing(new AnthropicApiError(429, 'rate limited', 'rate_limit_error')),
        answer(['recovered']),
      ]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(texts(events), 'recovered');
      assert.equal(
        events.some((event) => event.type === 'error'),
        false,
        'the caller never sees an intermediate error',
      );
      assert.ok(events.at(-1)?.type === 'done');
      assert.equal(fake.calls(), 2);
    });

    it('retries an overload reported mid-stream before any text', async () => {
      const overloaded: Attempt = async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 1420 } } };
        yield { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } };
      };
      const fake = fakeTransport([overloaded, answer(['second try'])]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(texts(events), 'second try');
      assert.equal(fake.calls(), 2);
    });

    it('retries a network failure', async () => {
      const fake = fakeTransport([
        throwing(new AnthropicNetworkError('Could not reach api.anthropic.com.')),
        answer(['back online']),
      ]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(texts(events), 'back online');
      assert.equal(fake.calls(), 2);
    });

    it('retries a stream that ends before the answer is finished', async () => {
      const severed: Attempt = async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 1420 } } };
      };
      const fake = fakeTransport([severed, answer(['complete'])]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(texts(events), 'complete');
      assert.equal(fake.calls(), 2);
    });

    it('surfaces error{transient} only once retries are exhausted', async () => {
      const overloaded = () => throwing(new AnthropicApiError(529, 'overloaded', 'overloaded_error'));
      const fake = fakeTransport([overloaded(), overloaded(), overloaded()]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.deepEqual(events, [{ type: 'error', kind: 'transient', message: 'overloaded' }]);
      assert.equal(fake.calls(), 3, 'one attempt plus the two configured retries');
    });

    it('respects an empty retry policy', async () => {
      const fake = fakeTransport([throwing(new AnthropicApiError(529, 'overloaded'))]);

      const events = await collect(provider(fake, { retryDelaysMs: [] }).solve(IMAGE));

      assert.equal(events.length, 1);
      assert.equal(fake.calls(), 1);
    });

    it('keeps partial text and surfaces the error when a stream dies mid-answer', async () => {
      const diesLate: Attempt = async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '# Sum\n```js\n' } };
        yield { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } };
      };
      const fake = fakeTransport([diesLate]);

      const events = await collect(provider(fake).solve(IMAGE));

      assert.equal(texts(events), '# Sum\n```js\n');
      assert.ok(events.at(-1)?.type === 'error');
      assert.equal(fake.calls(), 1, 'a retry here would duplicate text already on screen');
    });
  });

  describe('aborting', () => {
    it('stops the iterable mid-stream without throwing or emitting a terminal event', async () => {
      const controller = new AbortController();
      const slow: Attempt = async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'third' } };
        yield { type: 'message_stop' };
      };
      const fake = fakeTransport([slow]);

      const events: SolveEvent[] = [];
      for await (const event of provider(fake).solve(IMAGE, { signal: controller.signal })) {
        events.push(event);
        if (events.length === 1) controller.abort();
      }

      assert.deepEqual(events, [{ type: 'delta', text: 'first' }]);
      assert.equal(fake.calls(), 1);
    });

    it('does not call the transport at all when the signal is already aborted', async () => {
      const fake = fakeTransport([answer(['unreachable'])]);

      const events = await collect(provider(fake).solve(IMAGE, { signal: AbortSignal.abort() }));

      assert.deepEqual(events, []);
      assert.equal(fake.calls(), 0);
    });

    it('stops instead of retrying when aborted during a backoff', async () => {
      const controller = new AbortController();
      const fake = fakeTransport([
        throwing(new AnthropicApiError(529, 'overloaded', 'overloaded_error')),
        answer(['unreachable']),
      ]);
      const timer = setTimeout(() => controller.abort(), 10);

      const events = await collect(
        // Long enough that the abort has to land inside the wait.
        provider(fake, { retryDelaysMs: [5_000] }).solve(IMAGE, { signal: controller.signal }),
      );
      clearTimeout(timer);

      assert.deepEqual(events, [], 'an aborted solve emits no terminal event');
      assert.equal(fake.calls(), 1, 'the retry never fires');
    });
  });

  it('reports the model it is configured with', () => {
    const fake = fakeTransport([]);
    assert.equal(provider(fake).model, 'claude-sonnet-5');
    assert.equal(provider(fake, { model: 'claude-opus-5' }).model, 'claude-opus-5');
  });
});
