import { StartupError } from './errors.ts';
import { createSecret, type Secret } from './secret.ts';

export const API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';
export const OPENCODE_API_KEY_ENV_VAR = 'OPENCODE_API_KEY';
export const OPENCODE_GO_API_KEY_ENV_VAR = 'OPENCODE_GO_API_KEY';
export const OPENROUTER_API_KEY_ENV_VAR = 'OPENROUTER_API_KEY';
export const GEMINI_API_KEY_ENV_VAR = 'GEMINI_API_KEY';

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

/** Optional because an Anthropic key remains a supported fallback provider. */
export function takeOpenCodeApiKey(env: NodeJS.ProcessEnv): Secret | null {
  const raw = env[OPENCODE_API_KEY_ENV_VAR];
  delete env[OPENCODE_API_KEY_ENV_VAR];
  const value = raw?.trim() ?? '';
  return value === '' ? null : createSecret(value);
}

/** The Go subscription key is separate from the pay-as-you-go Zen key. */
export function takeOpenCodeGoApiKey(env: NodeJS.ProcessEnv): Secret | null {
  const raw = env[OPENCODE_GO_API_KEY_ENV_VAR];
  delete env[OPENCODE_GO_API_KEY_ENV_VAR];
  const value = raw?.trim() ?? '';
  return value === '' ? null : createSecret(value);
}

export function takeOpenRouterApiKey(env: NodeJS.ProcessEnv): Secret | null {
  return takeOptionalKey(env, OPENROUTER_API_KEY_ENV_VAR);
}

export function takeGeminiApiKey(env: NodeJS.ProcessEnv): Secret | null {
  return takeOptionalKey(env, GEMINI_API_KEY_ENV_VAR);
}

function takeOptionalKey(env: NodeJS.ProcessEnv, name: string): Secret | null {
  const raw = env[name];
  delete env[name];
  const value = raw?.trim() ?? '';
  return value === '' ? null : createSecret(value);
}

export const DEEPGRAM_API_KEY_ENV_VAR = 'DEEPGRAM_API_KEY';

/**
 * The same take-it-and-delete-it rule as {@link takeApiKey}, for the
 * transcription key -- including on the missing path, since the renderer
 * snapshots `process.env` at creation and must never see either key.
 *
 * Returns `null` instead of throwing, which is the one real difference. A
 * missing Anthropic key means the app has nothing to do and refuses to start
 * (`errors.ts`: "The app either comes up in a fully usable state or it prints
 * one clear line and exits"). A missing Deepgram key only means the recording
 * toggle reports `'unavailable'` -- every other thing this app does still
 * works, so refusing to start over it would be a strictly worse trade. That is
 * a deliberate carve-out from the no-degraded-mode rule, scoped to one
 * optional capability rather than a general loosening of it.
 */
export function takeDeepgramApiKey(env: NodeJS.ProcessEnv): Secret | null {
  const raw = env[DEEPGRAM_API_KEY_ENV_VAR];
  delete env[DEEPGRAM_API_KEY_ENV_VAR];

  const value = raw?.trim() ?? '';
  return value === '' ? null : createSecret(value);
}
