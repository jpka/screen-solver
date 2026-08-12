import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { silentLogger, type Logger } from '../logger.ts';
import type { ScreenRecordingLog } from '../logs/screen-recording-log.ts';
import { segmentPath } from '../screen-recording/segment-writer.ts';
import { sendJson, type Route } from './router.ts';

/**
 * `GET /screen-recordings/file?id=…` — serves one recorded segment (#47).
 *
 * **Why a query string and not `/recordings/:id`.** `router.ts` matches
 * pathnames exactly and says so in a comment: "the v1 HTTP surface has no path
 * parameters". This is the first endpoint that genuinely needs a parameter, and
 * the choice was between teaching the router pattern matching or putting the
 * parameter in the query string. The query string wins: it keeps the router's
 * invariant true for every other route, and it keeps the routing table a plain
 * `Map` lookup rather than an ordered scan with precedence rules.
 *
 * **Why `Range` matters.** Without it, `<video>` cannot seek — Chromium will
 * refuse to scrub, and on some paths will refuse to play at all, because it
 * can't ask for the moov/cluster offsets it wants. A recording you can't scrub
 * isn't much of a recording, so this is a requirement rather than an
 * optimization.
 */

export interface SegmentFileRouteDeps {
  readonly screenRecordingLog: ScreenRecordingLog;
  /** `<stateRoot>/recordings`. */
  readonly dir: string;
  readonly logger?: Logger;
}

export function createSegmentFileRoute(deps: SegmentFileRouteDeps): Route {
  const logger = deps.logger ?? silentLogger;

  return {
    method: 'GET',
    path: '/screen-recordings/file',
    handle: async ({ res, url, req }) => {
      const id = url.searchParams.get('id');
      if (id === null || id === '') {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }

      // Resolved through the index rather than treated as a filename. This is
      // the security-relevant step: `id` is attacker-controlled input on a
      // server bound to the local network, and building a path directly out of
      // it is exactly the shape a traversal takes (`?id=../../../../config`).
      // Looking it up means only ids this process itself minted can resolve at
      // all, and the containment check below is the belt to that suspenders.
      const index = await deps.screenRecordingLog.readIndex();
      const segment = index.find((candidate) => candidate.id === id);
      if (segment === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const path = safeSegmentPath(deps.dir, segment.id, segment.mimeType);
      if (path === null) {
        logger.error(`recording: refused to serve a segment path outside ${deps.dir} for id ${id}`);
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }

      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        // Indexed but gone from disk — a hand-deleted file, or a prune that
        // unlinked before its tombstone landed.
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const range = parseRangeHeader(req.headers.range, size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }

      const headers: Record<string, string> = {
        'content-type': segment.mimeType,
        // Advertised unconditionally, including on the full-body response: it
        // is how the player learns it may range-request at all.
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };

      const start = range === null ? 0 : range.start;
      const end = range === null ? size - 1 : range.end;
      headers['content-length'] = String(size === 0 ? 0 : end - start + 1);
      if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${size}`;

      res.writeHead(range === null ? 200 : 206, headers);
      if (size === 0) {
        res.end();
        return;
      }

      const stream = createReadStream(path, { start, end });
      stream.on('error', (error) => {
        logger.error(`recording: failed streaming ${path}: ${error.message}`);
        // Headers are already out by this point, so there is no status left to
        // send — ending the response is the only honest signal available.
        res.end();
      });
      // Destroys the read stream if the client goes away mid-download, so a
      // phone that locks its screen halfway through a segment doesn't leave a
      // file handle pinned open.
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    },
  };
}

/**
 * The absolute path of a segment file, or `null` if it would escape `dir`.
 *
 * Exported for direct testing: the interesting inputs are the malicious ones,
 * and asserting on them through an HTTP round trip would test the router more
 * than the check.
 */
export function safeSegmentPath(dir: string, id: string, mimeType: string): string | null {
  // A segment id names one file directly under `dir` — it is never a path.
  // Rejecting separators up front is what makes that contract hold *here*
  // rather than depending on the route's own empty-id check, which review of
  // this function in isolation showed were the only thing stopping two odd
  // cases: an empty id resolving to a bare `.webm`, and a POSIX-absolute id
  // like `/etc/passwd` being folded by `join` into `<dir>/etc/passwd.webm`.
  // Neither escaped `dir` — containment held — but both produced a path nobody
  // intended, and a function this security-sensitive should not have a contract
  // that is only true because of its caller.
  if (id === '' || id === '.' || id === '..' || /[/\\]/.test(id)) return null;

  const root = resolve(dir);
  const candidate = resolve(segmentPath(root, id, mimeType));
  const rel = relative(root, candidate);
  // Inside `root` iff the relative path neither climbs out nor is itself
  // absolute (which `relative` returns when the two are on different drives —
  // a real case on Windows, where this app lives).
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}

/**
 * Parses a `Range` header against a known file size.
 *
 * Returns `null` for "no range asked for, send the whole thing" — which
 * deliberately includes syntactically odd or multi-range headers: RFC 9110
 * allows a server to ignore a `Range` it doesn't want to honour and answer
 * `200`, and that is far better behaviour than erroring at a media player that
 * will happily accept the full body.
 *
 * `'unsatisfiable'` is reserved for a well-formed range that falls entirely
 * past the end of the file, which is the one case the spec says must be a
 * `416` rather than a silent full-body reply.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | 'unsatisfiable' | null {
  if (header === undefined || size === 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // A suffix range (`bytes=-500`): the last N bytes. Clamped rather than
    // rejected when N exceeds the file, per RFC 9110.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}
