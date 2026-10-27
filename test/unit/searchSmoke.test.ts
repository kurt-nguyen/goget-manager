import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const srcDir = join(root, 'src');
const SEARCH_CLIENT = 'src/vscode/searchClient.ts';

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Removes // and block comments while leaving string and template literal
 * contents intact, so URLs inside strings are not mistaken for comments.
 */
function stripTsComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i];
          i++;
        }
        if (i < source.length) {
          out += source[i];
          i++;
        }
      }
      if (i < source.length) {
        out += source[i];
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function toPosix(file: string): string {
  return relative(root, file).split(sep).join('/');
}

describe('media/search.css', () => {
  const css = stripCssComments(readFileSync(join(root, 'media', 'search.css'), 'utf8'));

  // The original rules end with `#search:focus`; every rule after it is new.
  const firstNewRule = css.search(/^\.loading\s*\{/m);
  const newCss = firstNewRule === -1 ? '' : css.slice(firstNewRule);

  function ruleBody(selector: string): string | undefined {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    return match?.[1];
  }

  it('has new rules after the original #search rules', () => {
    expect(firstNewRule).toBeGreaterThan(css.indexOf('#search:focus'));
    expect(newCss).toContain('.status');
    expect(newCss).toContain('.results');
    expect(newCss).toContain('.result-button');
  });

  it('draws a visible focus indicator on .result-button:focus-visible with focusBorder (Req 5.2)', () => {
    const body = ruleBody('.result-button:focus-visible');
    expect(body).toBeDefined();
    expect(body).toMatch(/outline\s*:[^;]*var\(\s*--vscode-focusBorder\s*[,)]/);
    expect(body).not.toMatch(/outline\s*:\s*(none|0)\b/);
  });

  it('uses the theme variables for loading, status, and hover (Req 7.3)', () => {
    expect(newCss).toContain('var(--vscode-progressBar-background)');
    expect(newCss).toContain('var(--vscode-descriptionForeground)');
    expect(newCss).toContain('var(--vscode-list-hoverBackground)');
  });

  it('contains no hard-coded colors in the new rules (Req 7.3)', () => {
    const NAMED_COLORS = new Set(
      (
        'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
        'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
        'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
        'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
        'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
        'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
        'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
        'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
        'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
        'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
        'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
        'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
        'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
        'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
        'teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen'
      ).split(' '),
    );
    const COLOR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i;
    const HEX = /#[0-9a-f]{3,8}\b/i;

    const declarations = [...newCss.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)];
    expect(declarations.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const declaration of declarations) {
      const property = declaration[1]!;
      const rawValue = declaration[2]!;
      // Drop `var(--name` so fallback values inside var() are still scanned.
      const value = rawValue.replace(/var\(\s*--[\w-]+/gi, ' ');
      if (HEX.test(value) || COLOR_FUNCTION.test(value)) {
        violations.push(`${property}: ${rawValue.trim()}`);
        continue;
      }
      const words = value.toLowerCase().split(/[^a-z0-9-]+/);
      if (words.some((word) => NAMED_COLORS.has(word))) {
        violations.push(`${property}: ${rawValue.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('network use in src (Req 8.6)', () => {
  const files = listTsFiles(srcDir).map((file) => ({
    path: toPosix(file),
    code: stripTsComments(readFileSync(file, 'utf8')),
  }));

  const NETWORK_MODULES = new Set(['https', 'http', 'net', 'tls', 'http2']);
  const SPECIFIER_PATTERNS = [
    /\bfrom\s*(['"])([^'"]+)\1/g,
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s+[\w$]+\s*=\s*require\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];

  function networkImports(code: string): string[] {
    const found: string[] = [];
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const raw = match[2]!;
        const specifier = raw.replace(/^node:/, '');
        if (NETWORK_MODULES.has(specifier)) found.push(raw);
      }
    }
    return found;
  }

  it('scans the source files, including the webview', () => {
    const paths = files.map((file) => file.path);
    expect(paths).toContain(SEARCH_CLIENT);
    expect(paths.some((path) => path.startsWith('src/webview/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('src/core/'))).toBe(true);
  });

  it('imports https, http, net, or tls only in src/vscode/searchClient.ts', () => {
    const offenders = files
      .filter((file) => file.path !== SEARCH_CLIENT)
      .map((file) => ({ path: file.path, imports: networkImports(file.code) }))
      .filter((file) => file.imports.length > 0);
    expect(offenders).toEqual([]);
  });

  it('imports node:https in src/vscode/searchClient.ts', () => {
    const client = files.find((file) => file.path === SEARCH_CLIENT);
    expect(client).toBeDefined();
    expect(networkImports(client!.code)).toContain('node:https');
  });

  it.each([
    ['fetch(', /(^|[^\w$.])fetch\s*\(/],
    ['globalThis.fetch / window.fetch', /\b(?:globalThis|window|self)\s*\.\s*fetch\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['navigator.sendBeacon', /\bsendBeacon\b/],
  ])('uses no %s in any src file, including src/webview', (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(file.code)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
