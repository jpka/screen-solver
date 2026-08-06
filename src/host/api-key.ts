import { StartupError } from './errors.ts';
import { createSecret, type Secret } from './secret.ts';

export const API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';

const MISSING_KEY_MESSAGE = [
  `${API_KEY_ENV_VAR} is not set.`,
  '',
  'Screen Solver reads the key once from the environment at startup and never',
  'stores it. Set it in your shell (or in a .env file next to package.json,',
  'which `npm start` loads for you) and start the app again:',
  '',
  `    $env:${API_KEY_ENV_VAR} = "sk-ant-..."   # PowerShell`,
  `    export ${API_KEY_ENV_VAR}=sk-ant-...     # bash`,
].join('\n');

/**
 * Read the API key out of the environment and take it with us.
 *
 * "Take" is the operative word: the variable is deleted from `env` on every
 * path, including the failure path, so no later code — and in particular no
 * renderer process, which inherits `process.env` at creation time — can reach
 * it. Callers hold the returned {@link Secret} for the life of the process.
 *
 * @throws {StartupError} `missing-api-key` when unset or blank.
 */
export function takeApiKey(env: NodeJS.ProcessEnv): Secret {
  const raw = env[API_KEY_ENV_VAR];
  delete env[API_KEY_ENV_VAR];

  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new StartupError('missing-api-key', MISSING_KEY_MESSAGE);
  }

  return createSecret(value);
}
