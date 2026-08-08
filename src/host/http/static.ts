import { readFile as readFileFs, readdir as readdirFs } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Route } from './router.ts';

/**
 * Minimal content-type table for the web client (#33): HTML, JS, CSS, plus a
 * fallback for anything else that ends up under `static/client/`. Not meant
 * to be exhaustive -- there is no upload surface here, only a fixed, small
 * set of files this repo itself wrote.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export interface StaticRoutesOptions {
  /** The directory to serve, walked recursively. Real production use is `static/client/` (#33's web client); see `src/main/paths.ts`. */
  readonly dir: string;
  /** Injected for tests; production lists the real directory. */
  readonly listFiles?: (dir: string) => Promise<readonly string[]>;
  /** Injected for tests; production reads real files. */
  readonly readFile?: (path: string) => Promise<Buffer>;
}

/**
 * Turns a directory of static assets into a flat list of exact-match `GET`
 * routes -- one per file, read into memory once at startup rather than on
 * every request, since the whole client is a handful of small files that
 * never change while the process is running (`router.ts`'s "no path
 * parameters" stays true: this still produces one route per literal path,
 * not a wildcard handler).
 *
 * `index.html` also gets a second route at `/` (or exactly `dir`'s own root
 * URL, if nested under a prefix a caller builds by hand), so opening the bare
 * server URL in a browser is the same as opening `/index.html`.
 */
export async function createStaticRoutes(options: StaticRoutesOptions): Promise<Route[]> {
  const listFiles = options.listFiles ?? defaultListFiles;
  const readFileImpl = options.readFile ?? ((path: string) => readFileFs(path));

  const relativePaths = await listFiles(options.dir);
  const routes: Route[] = [];

  for (const relativePath of relativePaths) {
    const contents = await readFileImpl(join(options.dir, relativePath));
    const urlPath = `/${relativePath.split('\\').join('/')}`;
    const contentType = CONTENT_TYPES[extname(relativePath)] ?? DEFAULT_CONTENT_TYPE;

    routes.push(fileRoute(urlPath, contentType, contents));
    if (urlPath === '/index.html') {
      routes.push(fileRoute('/', contentType, contents));
    }
  }

  return routes;
}

function fileRoute(path: string, contentType: string, contents: Buffer): Route {
  return {
    method: 'GET',
    path,
    handle: ({ res }) => {
      // No caching: the whole point of re-reading nothing per-request is
      // startup cost, not a promise to browsers that this content is stable
      // across process restarts (e.g. a rebuilt client).
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': contents.length,
        'cache-control': 'no-store',
      });
      res.end(contents);
    },
  };
}

async function defaultListFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdirFs(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}
