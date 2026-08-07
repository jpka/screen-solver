import { join } from 'node:path';
import { openJsonlFile, type JsonlFile } from './jsonl.ts';
import type { UsageLogEntry } from './types.ts';

export const USAGE_LOG_FILE_NAME = 'usage.jsonl';

export type UsageLog = JsonlFile<UsageLogEntry>;

export interface UsageLogOptions {
  readonly stateRoot: string;
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  readonly readFile?: (path: string) => Promise<string>;
}

/** `usage.jsonl` under the state root -- see `jsonl.ts` for the append/read mechanics this wraps. */
export function createUsageLog(options: UsageLogOptions): UsageLog {
  return openJsonlFile<UsageLogEntry>({
    path: join(options.stateRoot, USAGE_LOG_FILE_NAME),
    appendFile: options.appendFile,
    readFile: options.readFile,
  });
}
