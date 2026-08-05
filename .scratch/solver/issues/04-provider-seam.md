# Provider seam design

Parent: [Screen Solver](../map.md)
Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

What is the interface that every LLM provider sits behind?

**v1 ships with the Anthropic API only** ([decided directly, ticket 03](03-vision-provider-comparison.md) — no cross-provider comparison). The seam still gets designed generally: the one interface the rest of the app talks to, so that adding a second provider later touches exactly one file rather than a rewrite. Design against Anthropic's real API shape, not a hypothetical average of several providers.

Decide:

- **The interface itself** — what a caller passes in (image bytes plus what metadata? a prompt? a conversation?) and what it gets back (a stream of what, exactly).
- **Where the seam sits.** Does it hide only the HTTP call, or also prompt construction, image encoding, and retry? Deep module or thin adapter — and why.
- **How streaming is normalized.** Providers frame stream events differently; the app needs one event shape. Define it.
- **How errors, refusals, and rate limits are normalized** into something the UI can render without knowing the provider.
- **How a provider is selected and configured at runtime**, and what happens when a configured provider is unavailable.
- **What deliberately does not go behind the seam** — the things worth leaking provider-specific detail for.

Use `/codebase-design` vocabulary here. The output is an interface definition precise enough to implement against, not a sketch.

## Answer

**A deep module**, not a thin HTTP wrapper — prompt construction, image encoding, and retry all live inside it, so swapping providers later touches exactly one file instead of every call site that happens to know it's talking to Anthropic.

```ts
type ProviderConfig =
  | { provider: 'anthropic'; apiKey: string; model: string; systemPrompt: string }

function createProvider(config: ProviderConfig): Provider
// Throws immediately at startup / settings-save time if config is unrecognized
// or incomplete — never a solve-time failure.

interface Provider {
  solve(image: Buffer, options?: { signal?: AbortSignal }): AsyncIterable<SolveEvent>
}

type SolveEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; kind: 'rate_limit' | 'overloaded' | 'network' | 'auth' | 'refusal' | 'unknown'; message: string }
```

**Interface shape.** `solve()` takes raw image bytes (not base64 — that's Anthropic request mechanics, sealed inside) and an optional `AbortSignal` (accepted now so ticket 06's interrupt-vs-queue decision isn't foreclosed later, even though nothing uses it yet). No `prompt` parameter and no conversation/history — each call is a stateless, single-shot solve. The system prompt is **configured once at construction**, not threaded per-call, because it changes on a settings edit, not on a per-tick basis.

**Streaming normalization.** `delta` carries just the text chunk — no provider event names or content-block indices. `done` carries `usage` (input/output token counts) specifically because ticket 08 (cost control) needs real per-call numbers for its spend estimate, and the seam is the only place that ever sees them.

**Error normalization and retry split.** `rate_limit`, `overloaded`, and `network` are retried internally with backoff (transient, retrying is correct) and only surface as `error` if retries are exhausted. `auth` and `refusal` surface immediately — no amount of retrying fixes a bad key or a declined request. `unknown` is the catch-all so the UI always has something to render.

**Provider selection.** A factory (`createProvider`), not a registry or DI container — right-sized for one provider today, and adding a second means one new union member plus one new `case`. Selection happens once at startup (or on settings change), not per call; the main-process loop holds one live `Provider` and calls `solve()` on it repeatedly.

**Deliberately outside the seam:** whether/when to call `solve()` at all (change detection and budget enforcement decide that, not the module — it just reports `usage` after the fact); image capture and any pre-send downscaling/cropping (ticket 08's cost lever); and cross-call circuit-breaking (a runaway-protection concern for ticket 08, not something the module detects about its own call frequency). The module's only responsibility is one image in, one normalized event stream out.
