import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

// Compiles each test/integration/*.test.ts into out/test/integration/*.test.js.
// Helpers are bundled into every test file; `vscode` is provided by the host.
const entryPoints = readdirSync('test/integration')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `test/integration/${name}`);

await esbuild.build({
  entryPoints,
  outdir: 'out/test/integration',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
