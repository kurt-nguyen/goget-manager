import { afterEach, describe, expect, it, vi } from 'vitest';

// The module is replaced with a factory because `node:child_process` cannot be spied on under ESM.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile, default: { execFile } }));

import { createGoRunner } from '../../src/vscode/goRunner';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function respondWith(error: Error | null, stdout = '', stderr = ''): void {
  execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    callback(error, stdout, stderr);
  });
}

afterEach(() => {
  execFile.mockReset();
});

describe('createGoRunner', () => {
  it('passes the arguments untouched, without a shell, in the given folder with GOWORK=off', async () => {
    respondWith(null, 'out');
    const run = createGoRunner();
    await expect(run('/ws/a', ['get', '--', 'github.com/x/y'])).resolves.toEqual({ ok: true, output: 'out' });
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe('go');
    expect(args).toEqual(['get', '--', 'github.com/x/y']);
    expect(options.cwd).toBe('/ws/a');
    expect(options.shell).toBeUndefined();
    expect(options.env.GOWORK).toBe('off');
    expect(options.timeout).toBe(180_000);
    expect(options.maxBuffer).toBe(65_536);
  });

  it('maps ENOENT to notFound', async () => {
    respondWith(Object.assign(new Error('spawn go ENOENT'), { code: 'ENOENT' }));
    await expect(createGoRunner()('/ws', ['version'])).resolves.toMatchObject({ ok: false, reason: 'notFound' });
  });

  it('maps a killed process to timeout', async () => {
    respondWith(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }));
    await expect(createGoRunner()('/ws', ['get'])).resolves.toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('maps a non-zero exit to failed with stderr then stdout', async () => {
    respondWith(Object.assign(new Error('exit 1'), { code: 1 }), 'so', 'se');
    await expect(createGoRunner()('/ws', ['get'])).resolves.toEqual({ ok: false, reason: 'failed', output: 'seso' });
  });

  it('maps a maxBuffer overflow to failed, not timeout', async () => {
    respondWith(Object.assign(new Error('too much'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), 'x');
    await expect(createGoRunner()('/ws', ['get'])).resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('never rejects when execFile throws', async () => {
    execFile.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(createGoRunner()('/ws', ['get'])).resolves.toEqual({ ok: false, reason: 'failed', output: 'sync boom' });
  });
});
