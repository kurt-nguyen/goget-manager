import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGoRunner } from '../../src/vscode/goRunner';

// Opt-in: needs a local Go toolchain. Run with GOGET_LIVE=1.
describe.skipIf(process.env.GOGET_LIVE !== '1')('createGoRunner (live)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goget-runner-'));
  const run = createGoRunner();

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a requirement with go mod edit', async () => {
    expect(await run(dir, ['mod', 'init', 'example.com/probe'])).toMatchObject({ ok: true });
    expect(await run(dir, ['mod', 'edit', '-require=github.com/spf13/cobra@v1.8.0'])).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'go.mod'), 'utf8')).toContain('github.com/spf13/cobra');

    expect(await run(dir, ['mod', 'edit', '-droprequire=github.com/spf13/cobra'])).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'go.mod'), 'utf8')).not.toContain('github.com/spf13/cobra');
  });

  it('reports a failed go get with output', async () => {
    const result = await run(dir, ['get', '--', 'nonexistent.invalid/pkg']);
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(result.output).not.toBe('');
  });
});
