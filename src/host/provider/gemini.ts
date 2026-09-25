import { Buffer } from 'node:buffer';
import type { Secret } from '../secret.ts';
import { isAbortError, parseServerSentEvents } from './transport.ts';
import type { ModelChoice, Provider, SolveEvent, SolveImage, SolveOptions, Usage } from './types.ts';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_MODELS: readonly ModelChoice[] = Object.freeze([
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
]);
export interface GeminiProviderConfig { readonly apiKey: Secret; readonly systemPrompt: string; readonly model?: string; readonly models?: readonly ModelChoice[]; readonly fetch?: typeof globalThis.fetch; }

/** Native Gemini streaming adapter; inline image data avoids exposing captures by URL. */
export function createGeminiProvider(config: GeminiProviderConfig): Provider {
  const model = config.model ?? GEMINI_MODELS[0]?.id ?? 'gemini-2.5-flash';
  const models = config.models ?? GEMINI_MODELS;
  const doFetch = config.fetch ?? globalThis.fetch;
  async function* solve(image: SolveImage | null, options: SolveOptions = {}): AsyncGenerator<SolveEvent> {
    if (image === null && !options.transcript) { yield { type: 'error', kind: 'transient', message: 'A solve needs either a screenshot or a transcript; this request had neither.' }; return; }
    const selected = options.model ?? model;
    let response: Response;
    try { response = await doFetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(selected)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey.reveal() }, body: JSON.stringify(request(config.systemPrompt, image, options.transcript)), signal: options.signal }); }
    catch (error) { if (isAbortError(error) || options.signal?.aborted) return; yield { type: 'error', kind: 'transient', message: 'Could not reach Gemini.' }; return; }
    if (!response.ok) { yield { type: 'error', kind: response.status === 401 || response.status === 403 ? 'auth' : 'transient', message: await errorMessage(response) }; return; }
    if (response.body === null) { yield { type: 'error', kind: 'transient', message: 'Gemini returned no response body.' }; return; }
    let usage: Usage = ZERO_USAGE; let finished = false;
    try { for await (const raw of parseServerSentEvents(readBytes(response.body))) { if (options.signal?.aborted) return; const event = raw as GeminiChunk; const candidate = event.candidates?.[0]; for (const part of candidate?.content?.parts ?? []) if (part.text) yield { type: 'delta', text: part.text }; if (candidate?.finishReason) finished = true; if (event.usageMetadata) usage = { inputTokens: event.usageMetadata.promptTokenCount ?? 0, outputTokens: event.usageMetadata.candidatesTokenCount ?? 0, cacheCreationInputTokens: 0, cacheReadInputTokens: event.usageMetadata.cachedContentTokenCount ?? 0 }; } }
    catch (error) { if (isAbortError(error) || options.signal?.aborted) return; yield { type: 'error', kind: 'transient', message: error instanceof Error ? error.message : String(error) }; return; }
    if (!finished) { yield { type: 'error', kind: 'transient', message: 'The Gemini stream ended before the answer was complete.' }; return; }
    yield { type: 'done', usage, stopReason: 'stop' };
  }
  return Object.freeze({ model, models: Object.freeze([...models]), solve });
}

function request(system: string, image: SolveImage | null, transcript: string | undefined): object { return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [...(image === null ? [] : [{ inlineData: { mimeType: image.mediaType, data: Buffer.from(image.bytes).toString('base64') } }]), ...(transcript ? [{ text: `<recent_transcript>\n${transcript}\n</recent_transcript>` }] : [])] }] }; }
interface GeminiChunk { readonly candidates?: readonly { readonly content?: { readonly parts?: readonly { readonly text?: string }[] }; readonly finishReason?: string }[]; readonly usageMetadata?: { readonly promptTokenCount?: number; readonly candidatesTokenCount?: number; readonly cachedContentTokenCount?: number }; }
const ZERO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
async function errorMessage(response: Response): Promise<string> { const text = await response.text().catch(() => ''); try { const body = JSON.parse(text) as { error?: { message?: string } }; return (body.error?.message ?? text) || `Gemini returned HTTP ${response.status}.`; } catch { return text || `Gemini returned HTTP ${response.status}.`; } }
async function* readBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> { const reader = stream.getReader(); try { for (;;) { const { done, value } = await reader.read(); if (done) return; if (value) yield value; } } finally { await reader.cancel().catch(() => {}); } }
