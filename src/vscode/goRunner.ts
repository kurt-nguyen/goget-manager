import { execFile } from 'node:child_process';
import type { GoRunner } from '../core/packageActions';

export interface GoRunnerOptions {
  readonly goBinary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

interface ExecError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
}

/**
 * Runs `go` with an argument array (no shell) and never rejects. `GOWORK=off`
 * keeps the go.mod that is edited the same one the Installed view reads.
 */
export function createGoRunner(options: GoRunnerOptions = {}): GoRunner['run'] {
  const goBinary = options.goBinary ?? 'go';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return (cwd, args) =>
    new Promise((resolve) => {
      try {
        execFile(
          goBinary,
          [...args],
          { cwd, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GOWORK: 'off' } },
          (error, stdout, stderr) => {
            const output = `${String(stderr ?? '')}${String(stdout ?? '')}`;
            if (error === null) {
              resolve({ ok: true, output });
              return;
            }
            const err = error as ExecError;
            if (err.code === 'ENOENT') {
              resolve({ ok: false, reason: 'notFound', output });
            } else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              resolve({ ok: false, reason: 'failed', output });
            } else if (err.killed === true || (err.signal !== undefined && err.signal !== null)) {
              resolve({ ok: false, reason: 'timeout', output });
            } else {
              resolve({ ok: false, reason: 'failed', output: output === '' ? err.message : output });
            }
          },
        );
      } catch (err) {
        resolve({ ok: false, reason: 'failed', output: err instanceof Error ? err.message : String(err) });
      }
    });
}
