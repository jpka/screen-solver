import { Buffer } from 'node:buffer';
import type { Secret } from '../secret.ts';
import { isAbortError, parseServerSentEvents } from './transport.ts';
import type { ModelChoice, Provider, SolveEvent, SolveImage, SolveOptions, Usage } from './types.ts';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS: readonly ModelChoice[] = Object.freeze([
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
]);

export interface OpenRouterProviderConfig { readonly apiKey: Secret; readonly systemPrompt: string; readonly model?: string; readonly models?: readonly ModelChoice[]; readonly fetch?: typeof globalThis.fetch; }

/** OpenRouter's OpenAI-compatible chat-completions stream adapter. */
export function createOpenRouterProvider(config: OpenRouterProviderConfig): Provider {
  const model = config.model ?? OPENROUTER_MODELS[0]?.id ?? 'google/gemini-2.5-flash';
  const models = config.models ?? OPENROUTER_MODELS;
  const doFetch = config.fetch ?? globalThis.fetch;
  async function* solve(image: SolveImage | null, options: SolveOptions = {}): AsyncGenerator<SolveEvent> {
    if (image === null && !options.transcript) { yield { type: 'error', kind: 'transient', message: 'A solve needs either a screenshot or a transcript; this request had neither.' }; return; }
    let response: Response;
    try {
      response = await doFetch(`${OPENROUTER_BASE_URL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey.reveal()}`, 'content-type': 'application/json', accept: 'text/event-stream', 'x-openrouter-title': 'Screen Solver' }, body: JSON.stringify(request(config.systemPrompt, options.model ?? model, image, options.transcript)), signal: options.signal });
    } catch (error) { if (isAbortError(error) || options.signal?.aborted) return; yield { type: 'error', kind: 'transient', message: 'Could not reach OpenRouter.' }; return; }
    if (!response.ok) { yield { type: 'error', kind: response.status === 401 || response.status === 403 ? 'auth' : 'transient', message: await errorMessage(response) }; return; }
    if (response.body === null) { yield { type: 'error', kind: 'transient', message: 'OpenRouter returned no response body.' }; return; }
    let usage: Usage = ZERO_USAGE; let finishReason: string | null = null;
    try {
      for await (const raw of parseServerSentEvents(readBytes(response.body))) {
        if (options.signal?.aborted) return;
        const event = raw as ChatChunk; const choice = event.choices?.[0];
        if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (event.usage) usage = { inputTokens: event.usage.prompt_tokens ?? 0, outputTokens: event.usage.completion_tokens ?? 0, cacheCreationInputTokens: 0, cacheReadInputTokens: event.usage.prompt_tokens_details?.cached_tokens ?? 0 };
      }
    } catch (error) { if (isAbortError(error) || options.signal?.aborted) return; yield { type: 'error', kind: 'transient', message: error instanceof Error ? error.message : String(error) }; return; }
    if (finishReason === null) { yield { type: 'error', kind: 'transient', message: 'The OpenRouter stream ended before the answer was complete.' }; return; }
    if (finishReason === 'content_filter') { yield { type: 'error', kind: 'refusal', message: 'OpenRouter filtered this answer.' }; return; }
    yield { type: 'done', usage, stopReason: finishReason };
  }
  return Object.freeze({ model, models: Object.freeze([...models]), solve });
}

function request(system: string, model: string, image: SolveImage | null, transcript: string | undefined): object { return { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: [...(image === null ? [] : [{ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}` } }]), ...(transcript ? [{ type: 'text', text: `<recent_transcript>\n${transcript}\n</recent_transcript>` }] : [])] }] }; }
interface ChatChunk { readonly choices?: readonly { readonly delta?: { readonly content?: string }; readonly finish_reason?: string | null }[]; readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly prompt_tokens_details?: { readonly cached_tokens?: number } }; }
const ZERO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
async function errorMessage(response: Response): Promise<string> { const text = await response.text().catch(() => ''); try { const body = JSON.parse(text) as { error?: { message?: string } }; return (body.error?.message ?? text) || `OpenRouter returned HTTP ${response.status}.`; } catch { return text || `OpenRouter returned HTTP ${response.status}.`; } }
async function* readBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> { const reader = stream.getReader(); try { for (;;) { const { done, value } = await reader.read(); if (done) return; if (value) yield value; } } finally { await reader.cancel().catch(() => {}); } }
