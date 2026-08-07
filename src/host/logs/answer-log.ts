import { join } from 'node:path';
import { openJsonlFile, type JsonlFile } from './jsonl.ts';
import type { AnswerLogEntry } from './types.ts';

export const ANSWER_LOG_FILE_NAME = 'answers.jsonl';

export type AnswerLog = JsonlFile<AnswerLogEntry>;

export interface AnswerLogOptions {
  readonly stateRoot: string;
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  readonly readFile?: (path: string) => Promise<string>;
}

/** `answers.jsonl` under the state root -- see `jsonl.ts` for the append/read mechanics this wraps. */
export function createAnswerLog(options: AnswerLogOptions): AnswerLog {
  return openJsonlFile<AnswerLogEntry>({
    path: join(options.stateRoot, ANSWER_LOG_FILE_NAME),
    appendFile: options.appendFile,
    readFile: options.readFile,
  });
}
