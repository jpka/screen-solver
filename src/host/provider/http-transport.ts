/** Shared outbound HTTP seam for provider adapters. Domain modules build and interpret provider payloads; this module owns fetch mechanics. */
export interface PostSseRequest { readonly url: string; readonly headers: Record<string, string>; readonly body: unknown; readonly signal?: AbortSignal; }
export type PostSseTransport = (request: PostSseRequest) => Promise<Response>;
export function createPostSseTransport(fetchImpl: typeof globalThis.fetch = globalThis.fetch): PostSseTransport {
  return (request) => fetchImpl(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: request.signal });
}
