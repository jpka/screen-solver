// Dev launcher for `npm start`.
//
// Electron has no `--env-file`, so this loads a repo-root `.env` (gitignored)
// into the environment of the child process and hands off. Deliberately the
// only place that touches `.env`: the app itself only ever reads
// `process.env`, so nothing in `src/` knows a dotenv file can exist.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const entry = fileURLToPath(new URL('../dist/main/index.js', import.meta.url));

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

if (!existsSync(entry)) {
  console.error(`Missing ${entry}. Run \`npm run build\` first.`);
  process.exit(1);
}

// Launch the repo root, not the entry file: Electron then reads package.json
// for the app name, which is what puts the state root at
// %APPDATA%\screen-solver\ rather than %APPDATA%\Electron\.
const child = spawn(electronPath, [repoRoot, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
