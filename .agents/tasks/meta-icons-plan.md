# Implementation Plan: Search_View meta icons (calendar / download)

Scope: presentation only. Do NOT touch `package.json`, `imgs/*`, `src/core/resultsParser.ts`, `src/core/resultView.ts`. Do NOT commit. This is one cohesive change, so the existing implement/review loop runs it as-is (no FEAT decomposition).

## Findings from exploration

- `src/webview/render.ts` `buildDescription` currently does:
  - `textSpan(dom, 'result-published', 'published ', entry.published)` (two text nodes: label + value)
  - `textSpan(dom, 'result-imported', 'Imported by ', entry.importedBy)`
  - `textSpan` creates a `span`, sets `class`, then `replaceChildren` with text nodes.
- `DomLike` has `createElement`, `createTextNode`, `replaceChildren`, `setAttribute`. All of the markup below needs only those, so **no DomLike extension and no change to either fake DOM class** (`test/unit/render.test.ts`, `test/unit/properties/sp06-render-results.test.ts`).
- Current CSP in `src/vscode/searchViewProvider.ts` line 16, exact string:
  `` const csp = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'`; ``
  There is no `img-src`, so images fall back to `default-src 'none'`. CSS `mask-image: url(data:...)` is an image fetch governed by `img-src`, so it **is blocked today**. `img-src data:` is needed.
- Decision (CSP): append `; img-src data:` to the string, giving
  `` `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src data:` ``.
  Rationale: smallest widening, data: URIs only, no remote or webview-resource images, script policy untouched, still no `unsafe-inline`. Alternative (SVG files in `media/` plus `img-src ${cspSource}`) needs extra files, `.vscodeignore` exceptions and URI plumbing for no benefit.
- Existing CSP tests only use `toContain` / `not.toContain('connect-src')`, so they stay green; add new assertions (below).
- `media/search.js` is the esbuild bundle of `src/webview/search.ts` (imports `render.ts`). `package.json` scripts: `build` = `node esbuild.mjs`, `typecheck` = `tsc --noEmit -p tsconfig.json`, `test` = `vitest --run`. `.vscodeignore` keeps `!media/search.js`. `.agents/` did not exist before this plan.

## Design decisions

1. **Markup** (per meta field, only when the field is defined, order version, published, imported unchanged):
   ```html
   <span class="result-published">
     <span class="result-icon icon-calendar" title="Publish date" role="img" aria-label="Publish date"></span>
     {published text node}
   </span>
   <span class="result-imported">
     <span class="result-icon icon-download" title="Number of import" role="img" aria-label="Number of import"></span>
     {importedBy text node}
   </span>
   ```
   Rationale: the wrapper keeps the existing `result-published` / `result-imported` classes (CSS and "no span for absent fields" semantics preserved). The value stays its own text node. `role="img"` + `aria-label` keeps the meaning that the removed word gave screen readers (the result `<button>` has `aria-describedby` on `.result-desc`, which includes the icon's label). `title` gives the hover tooltip. The icon span has no children and no text, so values are still only ever in text nodes.
2. **Icon rendering**: CSS `mask-image` with an inline `data:` SVG and `background-color: currentColor`, so icons follow `.result-meta`'s `--vscode-descriptionForeground` and every theme. Size 14px.
3. **Layout**: make the two icon-bearing wrappers `inline-flex` with `align-items: center` and `gap: 4px` (vertical alignment and gap with no magic offsets). `.result-version` stays `inline-block`.

## Steps

- [ ] 1. Add an icon helper and use it in `src/webview/render.ts`.
      Add (below `textSpan`):
      ```ts
      function iconSpan<N extends NodeLike>(dom: DomLike<N>, iconClass: string, tooltip: string): N {
        const icon = dom.createElement('span');
        dom.setAttribute(icon, 'class', `result-icon ${iconClass}`);
        dom.setAttribute(icon, 'title', tooltip);
        dom.setAttribute(icon, 'role', 'img');
        dom.setAttribute(icon, 'aria-label', tooltip);
        return icon;
      }

      function iconValueSpan<N extends NodeLike>(
        dom: DomLike<N>,
        className: string,
        iconClass: string,
        tooltip: string,
        value: string,
      ): N {
        const span = dom.createElement('span');
        dom.setAttribute(span, 'class', className);
        dom.replaceChildren(span, [iconSpan(dom, iconClass, tooltip), dom.createTextNode(value)]);
        return span;
      }
      ```
      Replace the two pushes in `buildDescription`:
      ```ts
      meta.push(iconValueSpan(dom, 'result-published', 'icon-calendar', 'Publish date', entry.published));
      meta.push(iconValueSpan(dom, 'result-imported', 'icon-download', 'Number of import', entry.importedBy));
      ```
      Use exactly the tooltip strings "Publish date" and "Number of import". Do not change anything else in the file (no `createElementNS`, no `innerHTML`).
      Files: `src/webview/render.ts`
      Verify: `npm run typecheck` passes. (Tests are fixed in steps 4-5, so expect the two old-text tests to fail until then; do steps 1-5 before running `npm test`.)

- [ ] 2. Add `img-src data:` to the CSP in `src/vscode/searchViewProvider.ts` line 16.
      New value: `` `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src data:` ``. Change nothing else.
      Files: `src/vscode/searchViewProvider.ts`
      Verify: `npm run typecheck` passes; the CSP tests updated in step 5 pass.

- [ ] 3. Add the icon CSS to `media/search.css`.
      Leave the existing rule at ~lines 155-161 unchanged:
      ```css
      .result-version,
      .result-published,
      .result-imported {
        display: inline-block;
        margin-right: 10px;
      }
      ```
      then append after it (later rule overrides `display` for the two icon wrappers):
      ```css
      .result-published,
      .result-imported {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .result-icon {
        display: inline-block;
        flex: none;
        width: 14px;
        height: 14px;
        background-color: currentColor;
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-position: center;
        mask-position: center;
        -webkit-mask-size: contain;
        mask-size: contain;
      }

      .icon-calendar {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' d='M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 10h14v10H5z'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' d='M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 10h14v10H5z'/%3E%3C/svg%3E");
      }

      .icon-download {
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17zM4 17h2v2h12v-2h2v4H4z'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17zM4 17h2v2h12v-2h2v4H4z'/%3E%3C/svg%3E");
      }
      ```
      Encoding rules used: `<` -> `%3C`, `>` -> `%3E`, single-quoted SVG attributes inside a double-quoted `url("...")`, no `#` characters present (would be `%23`), spaces left literal inside the quoted url. Calendar = 24x24 outline body with two top pegs and an evenodd-cut window; download = arrow pointing into an open tray. Keep both prefixed and unprefixed properties (older VS Code Electron needs `-webkit-`).
      Files: `media/search.css`
      Verify: `npm test` (the existing CSS tests in `test/unit/searchView.test.ts` still pass; new CSS assertions from step 5 pass).

- [ ] 4. Update `test/unit/properties/sp06-render-results.test.ts` for the new meta shape.
      - Add a helper next to `expectSpan`:
        ```ts
        function expectIconSpan(
          node: FakeNode, className: string, iconClass: string, tooltip: string, value: string,
        ): void {
          expect(node.kind).toBe('element');
          expect(node.tag).toBe('span');
          expect(classOf(node)).toBe(className);
          expect(node.children).toHaveLength(2);
          const [icon, text] = node.children as [FakeNode, FakeNode];
          expect(icon.kind).toBe('element');
          expect(icon.tag).toBe('span');
          expect(classOf(icon)).toBe(`result-icon ${iconClass}`);
          expect(icon.attrs.get('title')).toBe(tooltip);
          expect(icon.attrs.get('role')).toBe('img');
          expect(icon.attrs.get('aria-label')).toBe(tooltip);
          expect(icon.children).toHaveLength(0);
          expect(text.kind).toBe('text');
          expect(text.textContent).toBe(value);
        }
        ```
      - Change the `meta` array element type to `{ cls: string; text: string; icon?: { cls: string; tooltip: string } }`.
      - ~line 218-223: published entry becomes `{ cls: 'result-published', text: result.published, icon: { cls: 'icon-calendar', tooltip: 'Publish date' } }`; imported becomes `{ cls: 'result-imported', text: result.importedBy, icon: { cls: 'icon-download', tooltip: 'Number of import' } }` (no `published ` / `Imported by ` prefix).
      - In the `meta.forEach` (~line 237) call `expectIconSpan(child, expected.cls, expected.icon.cls, expected.icon.tooltip, expected.text)` when `expected.icon` is set, else `expectSpan(...)` (version).
      - The `expectedText` concatenation (`meta.map((m) => m.text).join('')`) stays valid: the icon span has no text, so total entry text is path + name + synopsis + values. Leave it.
      - `expectPlainTextOnly` and `ALLOWED_TAGS` (`li`, `button`, `span`) need no change: the icon is a `span` whose `textContent` stays `null`, and it has no children.
      - Keep the properties: no span for absent fields, each value its own text node, order version, published, imported.
      Files: `test/unit/properties/sp06-render-results.test.ts`
      Verify: `npx vitest --run test/unit/properties/sp06-render-results.test.ts` passes.

- [ ] 5. Update/add the other tests.
      - `test/unit/render.test.ts` (no existing assertion mentions the old text; add one test inside `describe('renderState ...')`): render a result `{ path: 'a/b', name: 'b', version: 'v1.0.0', published: 'Oct 6, 2026', importedBy: '1,289' }`, walk down `li > button > children[2] (result-desc) > result-meta`, and assert the three children in order have classes `result-version`, `result-published`, `result-imported`; the published span's first child has `attrs` `{ class: 'result-icon icon-calendar', title: 'Publish date', role: 'img', 'aria-label': 'Publish date' }` and second child text `'Oct 6, 2026'`; the imported span's first child has `{ class: 'result-icon icon-download', title: 'Number of import', role: 'img', 'aria-label': 'Number of import' }` and second child text `'1,289'`. Add a second test: a result with only `published` renders no `result-version`/`result-imported` span. Also assert no text node equals `'published '` or `'Imported by '`. (FakeNode here uses `attrs: Record<string,string>` and `text`.)
      - `test/unit/searchView.test.ts`: in `'declares a CSP using the nonce for the script'` add `expect(csp).toContain('img-src data:');`. In the `media/search.css` describe add a test that `css` contains `.result-icon`, `.icon-calendar`, `.icon-download`, and `mask-image`.
      - `test/unit/searchViewProvider.test.ts` (~line 127, `'keeps a CSP without connect-src ...'`): add `expect(csp).toContain('img-src data:');` and `expect(csp).not.toContain("'unsafe-inline'");`.
      Files: `test/unit/render.test.ts`, `test/unit/searchView.test.ts`, `test/unit/searchViewProvider.test.ts`
      Verify: `npm test` — whole suite passes (`vitest --run`).

- [ ] 6. Update spec docs (small edits, no requirements change needed).
      - `.kiro/specs/search-packages/design.md` lines 497-501: replace the two meta spans with
        ```html
        <span class="result-version"><version></span>
        <span class="result-published"><span class="result-icon icon-calendar" title="Publish date" role="img" aria-label="Publish date"></span><published></span>
        <span class="result-imported"><span class="result-icon icon-download" title="Number of import" role="img" aria-label="Number of import"></span><importedBy></span>
        ```
        Keep the sentence after the block ("Each `<…>` value is a separate text node…") and append: "The icons are empty spans drawn with CSS `mask-image` and `currentColor`; the tooltip is the `title`, and `role="img"` + `aria-label` keep the meaning for screen readers."
      - Same file, section 11 (`media/search.css`, ~line 524-532): add a bullet "Meta icons: `.result-icon` with `.icon-calendar` / `.icon-download` use `mask-image` data URIs on `currentColor`; the CSP therefore adds `img-src data:`." Also grep the file's CSP mention at line 25 ("The CSP (no inline script, nonce only)") and, if it lists the policy, add `img-src data:`.
      - `.kiro/specs/search-packages/tasks.md` line 172 (task 8.1): replace "`published <published>`, and `Imported by <importedBy>` spans" with "a `published` span (calendar icon span with title 'Publish date', then the value) and an `importedBy` span (download icon span with title 'Number of import', then the value)".
      - `.kiro/specs/search-packages/requirements.md`: no edits (grep: its "Imported by"/"published on" mentions are about the parser stripping labels, Req 3.4; Req 4.3/4.8 talk about values, not label text).
      - Leave `test/unit/searchArbitraries.ts` and `sample-pages/` alone (they model pkg.go.dev's HTML input, not the webview output).
      Files: `.kiro/specs/search-packages/design.md`, `.kiro/specs/search-packages/tasks.md`
      Verify: re-read the edited lines; `npm test` still passes.

- [ ] 7. Rebuild the bundle and run the full verification.
      Run, in order: `npm run typecheck`, `npm test`, `npm run build`. `npm run build` regenerates `media/search.js` from `src/webview/search.ts` (must be run after the `render.ts` change so the tracked bundle matches); confirm `git status --short` shows `media/search.js` modified and that it contains `Publish date` and `Number of import`. Confirm `package.json` and `imgs/` are NOT in `git status`.
      Files: `media/search.js` (generated)
      Verify: all three commands exit 0.

## Notes / limits

- Real-webview visual verification (icon rendering, tooltip hover, theme colors, CSP enforcement in the live webview) cannot be done headlessly. The automated checks cover the DOM shape, the CSS text, and the CSP string only. Recommend a manual check by launching the Extension Development Host (F5), searching a package, and hovering both icons in a light and a dark theme.
- Content edge: if `importedBy`/`published` is absent the whole wrapper (and icon) is omitted, as before (Req 4.8).
