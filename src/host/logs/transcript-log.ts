import { join } from 'node:path';
import { openJsonlFile, type JsonlFile } from './jsonl.ts';
import type { TranscriptEntry } from './types.ts';

export const TRANSCRIPT_LOG_FILE_NAME = 'transcript.jsonl';

export type TranscriptLog = JsonlFile<TranscriptEntry>;

export interface TranscriptLogOptions {
  readonly stateRoot: string;
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  readonly readFile?: (path: string) => Promise<string>;
}

/**
 * `transcript.jsonl` under the state root -- the third instance of the
 * `jsonl.ts` shape, exactly as that module's own doc comment anticipated, and
 * a thin wrapper for the same reason `answer-log.ts` is.
 *
 * One difference in *use* rather than mechanism, which `GET /transcript` has
 * to account for: `answers.jsonl` grows one line per button press, while this
 * grows one line every few seconds of speech. Reading it back unbounded would
 * eventually mean serving tens of megabytes to a phone, so the route caps what
 * it returns rather than handing back everything `readAll()` produces.
 */
export function createTranscriptLog(options: TranscriptLogOptions): TranscriptLog {
  return openJsonlFile<TranscriptEntry>({
    path: join(options.stateRoot, TRANSCRIPT_LOG_FILE_NAME),
    appendFile: options.appendFile,
    readFile: options.readFile,
  });
}
