// Serves the mock quiz's manual rig (`npm run mock-quiz`).
//
// The rig is a browser page, so it has to come off an HTTP origin: a
// `file://` page cannot `fetch('./quiz.json')`, and the quiz data deliberately
// lives in that one file rather than being inlined into the page (see
// `test/fixtures/mock-quiz/quiz.ts`).
//
// It reuses the host's own `createStaticRoutes` + `startHttpServer` rather
// than hand-rolling a second file server, which is also a small standing
// check that those two still serve a directory correctly. Node runs the
// imported `.ts` sources directly via type stripping, the same way `npm test`
// does -- no build step stands between this script and `src/`.
//
// Defaults to loopback: the quiz is meant to be *on screen* on the machine
// Screen Solver is watching, not opened from a phone. Override with
// MOCK_QUIZ_HOST / MOCK_QUIZ_PORT.

import { fileURLToPath } from 'node:url';
import { consoleLogger } from '../src/host/logger.ts';
import { startHttpServer } from '../src/host/http/server.ts';
import { createStaticRoutes } from '../src/host/http/static.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4321;

const dir = fileURLToPath(new URL('../test/fixtures/mock-quiz/', import.meta.url));
const host = process.env.MOCK_QUIZ_HOST?.trim() || DEFAULT_HOST;
const rawPort = process.env.MOCK_QUIZ_PORT?.trim();
const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`MOCK_QUIZ_PORT must be an integer between 0 and 65535, got "${rawPort}".`);
  process.exit(1);
}

const routes = await createStaticRoutes({ dir });
const server = await startHttpServer({ binding: { host, port }, routes, logger: consoleLogger });

console.log(`Mock quiz on ${server.url}`);
console.log('Point Screen Solver at this browser window, then walk the quiz with ← / →.');
console.log('Keys: ← → move, s speaks the problem, p hides the rig bar, e opens the crib sheet.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
