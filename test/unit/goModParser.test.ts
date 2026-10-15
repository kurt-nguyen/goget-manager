import { describe, expect, it } from 'vitest';
import { parseGoMod } from '../../src/core/goModParser';

const REALISTIC = [
  'module github.com/example/app',
  '',
  'go 1.21',
  '',
  'toolchain go1.21.5',
  '',
  'require (',
  '\tgithub.com/gin-gonic/gin v1.9.1',
  '\tgolang.org/x/sys v0.15.0 // indirect',
  ')',
  '',
  '// second block',
  'require (',
  '\tgithub.com/stretchr/testify v1.8.4',
  '\tgolang.org/x/text v0.14.0 // indirect',
  ')',
  '',
  'replace (',
  '\tgithub.com/old/pkg => github.com/new/pkg v1.0.0',
  '\tgolang.org/x/sys => ../sys',
  ')',
  '',
].join('\n');

function expectOk(text: string) {
  const result = parseGoMod(text);
  if (!result.ok) {
    throw new Error(`expected success, got error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

function expectFail(text: string) {
  const result = parseGoMod(text);
  if (result.ok) {
    throw new Error('expected failure, got success');
  }
  return result.error;
}

describe('parseGoMod', () => {
  it('parses an empty string as success with no dependencies and no module path', () => {
    const result = expectOk('');
    expect(result.dependencies).toEqual([]);
    expect(result.modulePath).toBeUndefined();
  });

  it('parses a realistic go.mod in file order, ignoring other directives and replace blocks', () => {
    const result = expectOk(REALISTIC);
    expect(result.modulePath).toBe('github.com/example/app');
    expect(result.dependencies).toEqual([
      { path: 'github.com/gin-gonic/gin', version: 'v1.9.1' },
      { path: 'golang.org/x/sys', version: 'v0.15.0' },
      { path: 'github.com/stretchr/testify', version: 'v1.8.4' },
      { path: 'golang.org/x/text', version: 'v0.14.0' },
    ]);
  });

  it('parses single-line require directives', () => {
    const result = expectOk('module m\nrequire github.com/a/b v1.0.0\nrequire "github.com/c/d" v2.0.0 // indirect\n');
    expect(result.dependencies).toEqual([
      { path: 'github.com/a/b', version: 'v1.0.0' },
      { path: 'github.com/c/d', version: 'v2.0.0' },
    ]);
  });

  it('preserves pseudo-versions and +incompatible versions verbatim', () => {
    const pseudo = 'v0.0.0-20210101120000-abcdef123456';
    const incompat = 'v2.0.0+incompatible';
    const result = expectOk(
      `module m\nrequire (\n\texample.com/pseudo ${pseudo}\n\texample.com/old ${incompat}\n)\n`,
    );
    expect(result.dependencies).toEqual([
      { path: 'example.com/pseudo', version: pseudo },
      { path: 'example.com/old', version: incompat },
    ]);
  });

  it('treats an empty block `require ()` as no dependencies', () => {
    const result = expectOk('module m\nrequire ()\nrequire a.com/x v1.0.0\n');
    expect(result.dependencies).toEqual([{ path: 'a.com/x', version: 'v1.0.0' }]);
  });

  it('handles CRLF line endings identically to LF', () => {
    const crlf = REALISTIC.replace(/\n/g, '\r\n');
    expect(parseGoMod(crlf)).toEqual(parseGoMod(REALISTIC));
    const result = expectOk(crlf);
    expect(result.dependencies[0]?.version).toBe('v1.9.1');
  });

  it('strips a leading BOM', () => {
    const result = expectOk('\uFEFF' + REALISTIC);
    expect(result.modulePath).toBe('github.com/example/app');
    expect(result.dependencies).toHaveLength(4);
  });

  it('reports an unterminated quote on its line with no dependencies', () => {
    const error = expectFail('module m\nrequire (\n\ta.com/x v1.0.0\n\t"b.com/y v1.0.0\n)\n');
    expect(error.line).toBe(4);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('reports a single-line require with extra tokens at that line', () => {
    const error = expectFail('module m\nrequire a.com/x v1.0.0 extra\n');
    expect(error.line).toBe(2);
  });

  it('reports a three-token entry inside a require block at that line', () => {
    const error = expectFail('module m\nrequire (\n\ta.com/x v1.0.0\n\tb.com/y v1.0.0 extra\n)\n');
    expect(error.line).toBe(4);
  });

  it('reports a require entry missing its version', () => {
    expect(expectFail('require a.com/x\n').line).toBe(1);
    expect(expectFail('require (\n\ta.com/x\n)\n').line).toBe(2);
  });

  it('reports an unclosed require block at the opening line', () => {
    const error = expectFail('module m\n\nrequire (\n\ta.com/x v1.0.0\n');
    expect(error.line).toBe(3);
  });

  it('uses the first module directive when several are present', () => {
    const result = expectOk('module first.com/a\nmodule second.com/b\n');
    expect(result.modulePath).toBe('first.com/a');
  });

  it('uses the first of `module` and `package` regardless of which verb it is', () => {
    expect(expectOk('module m.com/a\npackage p.com/b\n').modulePath).toBe('m.com/a');
    expect(expectOk('package p.com/b\nmodule m.com/a\n').modulePath).toBe('p.com/b');
  });
});
