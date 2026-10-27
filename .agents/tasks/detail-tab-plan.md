# Implementation Plan: package Detail tab (single reusable editor-area webview panel)

Scope: clicking a Search result opens ONE detail tab in the editor area. Clicking another result re-uses that tab. Data is scraped from pkg.go.dev in the extension host. Header section (properties + Install/Uninstall stub button) and main section (README + Documentation, GOOS dropdown when the page offers it).

This plan is decomposed into 3 sequential FEATs (artifacts in `.agents/tasks/task-detail-tab/`). The gate file for the review loop is `.agents/tasks/detail-tab-review.json` (`verdict` = `APPROVED`). Coders commit locally with explicit `git add <paths>` (never `.agents/`, never `sample-pages/`), never push.

## 1. Findings from exploration (code and live site actually read)

### Repo
- Build/test: `npm run build` (= `node esbuild.mjs`), `npm run typecheck` (= `tsc --noEmit -p tsconfig.json`, includes `src/**` and `test/**`), `npm test` (= `vitest --run`, only `test/unit/**/*.test.ts`, `vscode` aliased to `test/unit/vscodeStub.ts`). `npm run test:integration` needs a VS Code download; do not rely on it. Node 24 locally, extension targets `node18`, `vscode ^1.85`.
- `esbuild.mjs` has two configs: `src/extension.ts` -> `dist/extension.js` (node, cjs) and `src/webview/search.ts` -> `media/search.js` (browser iife, es2022). `media/search.js` is gitignored/generated (`.gitignore` lists it); `media/search.css` is tracked. `.vscodeignore` excludes `src/**`, `**/*.ts`, `test/**` etc. and re-includes `!media/search.js`. `npx vsce ls` currently also lists `sample-pages/**` and `.agents/**` (pre-existing bloat; this plan adds them to `.vscodeignore`).
- **HTTP helper already exists and is reused**: `src/vscode/searchClient.ts` `PkgGoDevSearchClient.search(url, signal)` is a generic `node:https` GET limited to `https://pkg.go.dev` (host check via `isPkgGoDevHttpsUrl`, redirects followed only within pkg.go.dev, max 5, body cap 5 MiB, `Accept-Encoding: identity`, proxy-friendly). It implements `SearchClient` from `src/core/searchController.ts` (`SearchResponse = ok{html} | failed{failure} | aborted`). The detail feature reuses `PkgGoDevSearchClient` + `nodeHttpsTransport` and does NOT use global `fetch`.
- **HTML tokenizer already exists and is reused**: `src/core/htmlTokens.ts` `tokenizeHtml(html)` is a lenient generator of `start{name,attrs:Map,selfClosing}` / `end{name}` / `text` tokens. It decodes only `&amp; &lt; &gt; &quot; &apos; &nbsp; &#N; &#xH;` (other named entities stay literal), lower-cases names, skips the CONTENT of `script/style/textarea/title`, skips comments/doctype, and stops (drops the tail) at an unterminated tag. No HTML parser dependency is added (repo has none; no new dependency).
- `src/core/resultsParser.ts` is the style reference for a scraper (selectors table at the top, never throws, tolerant). The detail scraper uses a small tree built from the tokens (new `htmlTree.ts`) because it must extract sub-trees and re-serialize them sanitized.
- Search view: `src/webview/render.ts` `buildResult` renders `li > button.result-button` with `aria-label=entry.path`, `data-version`, `data-index`. `src/webview/search.ts` click handler posts `{type:'open', resultsVersion, index}`; `SearchViewProvider` (`src/vscode/searchViewProvider.ts`) routes `open` to `SearchController.open()` which opens the browser (`vscode.env.openExternal`). `parseWebviewMessage` in `src/core/searchProtocol.ts` validates every webview message and never throws. Tests pin these: `test/unit/searchView.test.ts` (click posts `open`, ~line 274), `searchViewProvider.test.ts` (`new SearchViewProvider(...)` at lines ~94/144/440), `searchMessages.test.ts`, `properties/sp12-webview-messages.test.ts` (reference model of the parser; unknown type -> undefined), `render.test.ts` (uses `toMatchObject` on button attrs, so an added `data-path` attribute is safe).
- Installed detection (reuse, do not re-parse go.mod): `src/core/installedMatch.ts` `collectInstalledModulePaths(snapshot)` and `isInstalledPackage(path, Set)`; `GoModRepository.snapshot()` and `GoModRepository.onDidChange` (`src/vscode/goModRepository.ts`). `src/extension.ts` already builds `{ onDidChange: repository.onDidChange, modules: () => collectInstalledModulePaths(repository.snapshot()) }` as an `InstalledModulesSource` (type exported from `searchViewProvider.ts`). Note repository initialises asynchronously, so installed state must be recomputed on `onDidChange`.
- Conventions: pure logic in `src/core` (no `vscode` import, injected deps like `TimerApi`, `OutputLike`), vscode layer in `src/vscode`, webview scripts in `src/webview`; webview DOM built with `DomLike` (`render.ts`) and `textContent`, never from strings; strict CSP + nonce (`buildSearchHtml`); `randomBytes(16).toString('base64')` nonce; `localResourceRoots: [media]`; messages validated by a `parse*Message` that never throws; stale-response protection by a generation counter (`SearchController`); user-facing strings in `src/core/messages.ts`; tests in `test/unit/*.test.ts` + `properties/*` with fast-check; fixtures in `test/fixtures/`. `test/unit/vscodeStub.ts` has `Uri`, `EventEmitter` but no `ViewColumn`/`window`.

### pkg.go.dev (reference `sample-pages/package_detail.html` + live fetches of `os`, `golang.org/x/sys/unix`, `github.com/spf13/cobra`, `github.com/pkg/errors`, all HTTP 200)
- **The saved sample is NOT byte-identical to the live HTML. The scraper must handle live shape:** links are root-relative (`/syscall#O_RDONLY`, `/github.com/spf13/cobra?tab=licenses`), query-relative (`?tab=versions`) and fragment-only (`#pkg-overview`); images are root-relative (`/static/shared/icon/...`); boolean attributes are bare (`<option selected value="windows">`, `hidden`). The saved sample has absolute links with `?GOOS=windows` appended and `./package_detail_files/` image paths. All link resolution therefore uses `new URL(raw, 'https://pkg.go.dev/<path>')`.
- Without a `GOOS` query param NO `<option>` has `selected` (live `os`, `x/sys/unix`). pkg.go.dev's default is linux/amd64, which is the first option. Rule: selected = option with the `selected` attribute, else the first option. With `?GOOS=windows` the `windows` option is `selected` (verified live for `/os?GOOS=windows`).
- Only a `GOOS` param exists (option values `linux`, `windows`, `darwin`, `js`; labels `linux/amd64`, `windows/amd64`, `darwin/amd64`, `js/wasm`). There is no separate GOARCH selector, so "arch if offered" = the option label that already shows the arch. Dropdown present only on pages containing `select.js-buildContextSelect` (live: `os`, `x/sys/unix`, `spf13/cobra`; absent for `pkg/errors`).
- Selectors (all verified in sample and/or live):
  - header block: `header.go-Main-header`; title `h1[data-test-id=UnitHeader-title]`; chips `span.go-Chip` inside `.go-Main-headerTitle` (e.g. `package`, `module`; NOT the `Latest` chips that live inside the version item); import path `a[data-test-id=UnitHeader-breadcrumbCurrent]` (fallback `button.js-clipboard[data-to-copy]`, fallback requested path).
  - `[data-test-id=UnitHeader-version] a` (text after the `Version:` span; `aria-label="Version: v2.0.0-alpha2"`), `[data-test-id=UnitHeader-commitTime]` ("Published: May 4, 2026"), `[data-test-id=UnitHeader-licenses]` with one or more `a[data-test-id=UnitHeader-license]`, `[data-test-id=UnitHeader-imports] a` (`aria-label="Imports: 20"`), `[data-test-id=UnitHeader-importedby] a` (`aria-label="Imported By: 195,884"`). Any of these may be missing (stdlib has fewer).
  - aside: `aside.go-Main-aside .UnitMeta`; `ul.UnitMeta-details > li` with `details > summary` (label = text of summary, e.g. "Valid go.mod file", "Redistributable license", "Tagged version", "Stable version"; state = first `img` inside the summary has `alt="checked"` vs `alt="unchecked"`); the last `li.UnitMeta-detailsLearn` has no `summary` and is skipped; `.UnitMeta-repo a`; `ul.UnitMeta-links a`.
  - main: `article.go-Main-article`; README `.UnitReadme .Overview-readmeContent` (already rendered HTML, may be absent, absent for `os`); documentation `.UnitDoc .Documentation-content` (`.js-docContent`): overview, `section.Documentation-index`, constants, variables, functions, types, many `pre`/links; GOOS select `.UnitBuildContext-titleContext select.js-buildContextSelect`.
- Not extracted on purpose: Source Files (`.UnitFiles`), Directories (`.UnitDirectories`, hidden rows + JS toggles), survey banner, `go-Header`, nav/outline, footer, dialogs, scripts. A "View on pkg.go.dev" link in the header covers them. Documentation examples (`textarea`) lose their code because the tokenizer skips textarea content; accepted limitation.
- Size: `golang.org/x/sys/unix` is 2.2 MB of HTML (under the 5 MiB body cap); tokenising/tree-building must stay linear and non-recursive-deep (see htmlTree depth cap).

## 2. Decisions (rationale in 1-2 sentences each)

1. **Result-click message**: new webview -> host message `{ type: 'select', path: string }`. The path is read from a new `data-path` attribute on `.result-button`. The host validates it with `isValidImportPath` (so a forged path cannot reach the URL builder). The existing `open` message and `SearchController.open()` (browser) stay untouched and tested but are no longer sent by `search.ts`; this keeps the diff small and the old tests meaningful. Rationale: the requirement says the message carries the import path.
2. **One tab**: `DetailPanelManager` keeps `private panel: PanelLike | undefined`. `show(path)`: if a panel exists call `panel.reveal(undefined, true)` (keep its column, `preserveFocus` so the search box keeps focus and the user can click the next result), else create one with `ViewColumn.Active`; then `controller.show(path)`. `panel.onDidDispose` clears the reference and calls `controller.reset()`. `retainContextWhenHidden: true` (one tab, avoids re-render and keeps scroll of a large DOM) plus a `ready` handshake in which the host re-posts the full snapshot, so a re-created webview is always correct. No `WebviewPanelSerializer` (the tab is not restored after a window reload; acceptable).
3. **Controller is pure (src/core)**: `DetailController` owns state, fetch, timeout, stale protection (generation counter + `AbortController`, as `SearchController` does), GOOS changes, retry, installed flag, install/uninstall stub logging. The panel manager is a thin adapter. Rationale: testable without VS Code, matches existing split.
4. **Same-path re-click**: if the requested path equals the current path and status is `loading` or `ready`, only reveal (no refetch). If status is `error`, re-click retries.
5. **Header rendered from a structured model in the webview with DOM APIs; main section is the only `innerHTML`**, set from host-sanitized HTML into one container. Defence in depth: CSP forbids inline script, so even a sanitizer bug cannot run script.
6. **Sanitizer is an allowlist, not a blocklist**, runs in the host on the tree from `htmlTree.ts`, and re-serializes with escaped text/attrs.
7. **Link policy**: in-page fragment links scroll inside the webview; ALL other links (including pkg.go.dev links to other packages) open externally via `vscode.env.openExternal`. Recommendation: do not navigate the tab for internal package links now (no back/forward in a single tab; simplest and matches the requirement). A later change can intercept `https://pkg.go.dev/<valid import path>` in the `openLink` handler and call `controller.show(path)`.
8. **GOOS refetch replaces header+main model but shows a main-only loading state**; on failure the old content stays, an inline error with Retry appears in the main section and the select reverts.
9. **Stdlib packages** (e.g. `os`) are not in go.mod so they show Install. No special-casing (stub). Installed state = `isInstalledPackage(requestedPath, new Set(modules()))` recomputed on `repository.onDidChange`.
10. **Install/Uninstall**: webview posts `{type:'install'}` / `{type:'uninstall'}` (no path; the host uses its current path). Controller logs one line to the output channel ("not implemented yet"). No other effect.
11. **CSP** for the detail webview: `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src https: data: ${cspSource}; font-src ${cspSource}`. `img-src https:` is needed because READMEs embed remote badges; every sanitized `<img>` gets `loading="lazy" referrerpolicy="no-referrer"`. No `style-src 'unsafe-inline'` (style attributes are stripped).
12. **ids from scraped HTML are prefixed `pd-`** and fragment hrefs are rewritten to `#pd-...`, which prevents DOM clobbering of window/global names and collisions with our own `detail-*` ids. `name` attributes are dropped.
13. **README collapse**: the webview wraps the README in its own section; if its `scrollHeight` exceeds 480 px it starts collapsed with a Toggle button (`aria-expanded`), mirroring pkg.go.dev Expand/Collapse without copying its script.
14. **Scope cuts**: no Source Files/Directories sections, no tab=versions/imports panes, no panel persistence, no new commands/menus (package.json unchanged).

## 3. New / changed files

New, `src/core` (pure, no `vscode` import):
- `htmlTree.ts` : `parseHtmlTree(html): HtmlElement` over `tokenizeHtml`; node types `HtmlElement {kind:'element', name, attrs: ReadonlyMap<string,string>, children}` / `HtmlText {kind:'text', text}`; void elements list (copy from `resultsParser.ts`); end tag closes the nearest open ancestor with that name, ignored when none; depth cap 256 (deeper nodes attach to the cap-depth node); helpers `findFirst`, `findAll`, `textContent` (collapses whitespace), `hasClass`, `attr`.
- `htmlSanitize.ts` : `sanitizeNodes(nodes, ctx: { baseUrl: string }): string`; `resolveLink(raw, ctx)`; allowlists below.
- `packageDetail.ts` : `PackageDetail` type + `parsePackageDetail(html, requestedPath): PackageDetail | undefined` (SELECTORS table at top like `resultsParser.ts`).
- `detailUrl.ts` : `isValidImportPath(path)`, `packageDetailUrl(path, goos?)` -> `{ok:true,url}|{ok:false,reason}` (uses `isPkgGoDevHttpsUrl`; `goos` must match `/^[a-z0-9]{1,16}$/`).
- `detailProtocol.ts` : `DetailViewModel`, `HostToDetail`, `DetailToHost`, `parseDetailMessage(value)` (never throws, returns new object with allowed keys only).
- `detailController.ts` : `DetailController` (see section 5).
- `detailHtml.ts` : `buildDetailHtml(cspSource, nonce, cssUri, jsUri)` pure string builder (same role as `buildSearchHtml`).
- `messages.ts` (modify): add detail strings/log helpers (`DETAIL_LOADING`, `DETAIL_TIMED_OUT`, `DETAIL_BAD_PAGE`, `DETAIL_NOT_FOUND`, `DETAIL_INVALID_PATH`, `detailFailureLog(...)`, `installStubLog(...)`).

New, `src/vscode`:
- `detailPanelManager.ts` : `DetailPanelManager` (one-tab mechanism, message routing, `openExternal`).

New, `src/webview`:
- `detail.ts` : entry bundled to `media/detail.js` (acquireVsCodeApi, message listener, event delegation).
- `detailRender.ts` : DOM-building functions via `DomLike` (header, status/error, GOOS select) so unit tests use a fake DOM like `render.test.ts`.

New, `media/`:
- `detail.css` : theme-variable CSS (tracked). `media/detail.js` is generated and gitignored.

Changed:
- `src/core/searchProtocol.ts` : add `{type:'select', path}` to `WebviewToHost` and to `parseWebviewMessage` (path must satisfy `isValidImportPath`).
- `src/webview/render.ts` : `data-path` attribute on `.result-button`. `src/webview/search.ts` : click posts `select` with `data-path`.
- `src/vscode/searchViewProvider.ts` : optional 4th ctor arg `detail?: { show(path: string): void }`; `case 'select'` calls it.
- `src/extension.ts` : build `DetailController` (client `new PkgGoDevSearchClient(nodeHttpsTransport)`, output, `openExternal`, `isInstalled`), `DetailPanelManager`, wire `repository.onDidChange` -> `controller.refreshInstalled()`, pass manager to `SearchViewProvider`, push disposables.
- `esbuild.mjs` (third config `src/webview/detail.ts` -> `media/detail.js`), `.gitignore` (`media/detail.js`), `.vscodeignore` (`!media/detail.js`, `sample-pages/**`, `.agents/**`).
- `test/unit/vscodeStub.ts` : add `ViewColumn` enum (`Active=-1, Beside=-2, One=1, Two=2, Three=3`).
- Tests (see FEATs).

## 4. Scraper extraction (`parsePackageDetail`)

`PackageDetail` (all URLs absolute http(s), all text whitespace-normalised):
```ts
interface Link { readonly text: string; readonly url: string }
interface PackageDetail {
  readonly path: string;            // requested import path
  readonly pageUrl: string;         // https://pkg.go.dev/<path>
  readonly title: string;           // h1 text
  readonly importPath: string;      // canonical from breadcrumb / clipboard / path
  readonly chips: readonly string[];
  readonly version?: Link;          // text e.g. v2.0.0-alpha2, url = ?tab=versions
  readonly published?: string;      // "May 4, 2026" (text after "Published:")
  readonly licenses: readonly Link[];
  readonly imports?: Link;          // text = count, url = ?tab=imports
  readonly importedBy?: Link;
  readonly checks: readonly { readonly label: string; readonly ok: boolean }[];
  readonly repository?: Link;
  readonly links: readonly Link[];
  readonly readmeHtml?: string;     // sanitized
  readonly docHtml?: string;        // sanitized
  readonly buildContext?: { readonly selected: string; readonly options: readonly { value: string; label: string }[] };
}
```
Steps: `parseHtmlTree(html)` -> locate `header.go-Main-header`, `aside.go-Main-aside`, `article.go-Main-article` (header/aside/article missing individually is fine). Return `undefined` only when there is no `h1[data-test-id=UnitHeader-title]` AND no `article` (page not recognised -> controller reports `DETAIL_BAD_PAGE`). Field rules are in section 1 selectors. Counts: take the `aria-label` after the first `: ` (fallback to the anchor text minus the subtle label). `buildContext` is set only if the `select.js-buildContextSelect` exists and has at least one `option`; `selected` = option with the `selected` attribute else first. The README/doc HTML is `sanitizeNodes(children of the matched element, {baseUrl: pageUrl})`; empty result -> undefined. Never throws (wrap in try/catch returning `undefined`).

## 5. Message protocol

Search webview -> host (additive): `{ type: 'select'; path: string }`.

Detail webview <-> host (`src/core/detailProtocol.ts`):
```ts
export interface DetailViewModel {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly path: string;            // '' when idle
  readonly detail?: PackageDetail;  // present for ready (and kept while mainLoading / inline error)
  readonly goos?: string;           // currently shown GOOS (selected option value)
  readonly installed: boolean;
  readonly mainLoading: boolean;    // GOOS refetch in progress
  readonly error?: string;          // page error (status 'error') or inline main error (status 'ready')
}
export type HostToDetail =
  | { readonly type: 'state'; readonly state: DetailViewModel }
  | { readonly type: 'installed'; readonly installed: boolean };
export type DetailToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'changeGoos'; readonly goos: string }
  | { readonly type: 'openLink'; readonly url: string }
  | { readonly type: 'retry' }
  | { readonly type: 'install' }
  | { readonly type: 'uninstall' };
```
`parseDetailMessage`: `changeGoos.goos` must match `/^[a-z0-9]{1,16}$/`; `openLink.url` must be a string <= 2048 chars that `new URL()` parses with protocol `http:`, `https:` or `mailto:` (returns the normalised `href`); extra keys dropped; anything else -> `undefined`.

`DetailController` (`src/core/detailController.ts`) deps: `client: SearchClient`, `output: OutputLike`, `isInstalled(path): boolean`, `timers?: TimerApi`, `now?`, `timeoutMs?` (default 20_000). API: `get state()`, `snapshot(): HostToDetail`, `onDidChange(listener: (m: HostToDetail) => void)`, `show(path)`, `changeGoos(goos)` (only if status ready and `goos` is one of `detail.buildContext.options`), `retry()`, `refreshInstalled()`, `requestInstall()`, `requestUninstall()`, `reset()`, `dispose()`. `show` emits `state{loading}` synchronously, then fetches `packageDetailUrl(path)`; `changeGoos` emits `state{mainLoading:true}` then fetches `packageDetailUrl(path, goos)`; success -> `parsePackageDetail`, `undefined` -> error `DETAIL_BAD_PAGE`; failures map: `unreachable` -> `UNREACHABLE`, HTTP 404 -> `DETAIL_NOT_FOUND`, other http/redirectBlocked -> `httpError(status)`, timeout -> `DETAIL_TIMED_OUT`; each failure also logs one line (`detailFailureLog`). Stale responses (older generation) are ignored; starting a new request aborts the in-flight one. `refreshInstalled()` emits `{type:'installed'}` only when the flag changed.

## 6. Sanitization rules (`htmlSanitize.ts`)

- Allowed tags: `a abbr article b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead tr tt u ul var`.
- Dropped WITH their content: `script style iframe frame frameset object embed applet form template noscript textarea select option button input link meta base svg math audio video canvas dialog title head`.
- Any other unknown tag is unwrapped (children kept, tag removed).
- Allowed attributes: global `class` (tokens matching `/^[A-Za-z][\w-]*$/`), `id` (value `/^[\w:.\-]+$/`, output prefixed `pd-`), `title`, `lang`, `dir`; `a`: `href`; `img`: `src alt width height title`; `td/th`: `colspan rowspan align`; `ol`: `start`; `details`: `open`. Everything else is dropped: all `on*`, `style`, `srcset`, `name`, `target`, `formaction`, `data-*`, `aria-*`.
- `a`: output `href` only if the resolved URL protocol is `http:`/`https:`/`mailto:` (resolution through `new URL(raw, baseUrl)` which already strips tabs/newlines and decodes entities-obfuscated `javascript:`; `javascript:`, `data:`, `vbscript:`, `file:` etc. -> no href, tag kept as plain `<a>`). Always add `rel="noopener noreferrer"`. Fragment links (`#x`, or same-page URL with a hash, ignoring the `GOOS` param) -> `href="#pd-x"`. `GOOS` and `GOARCH` params are removed from pkg.go.dev URLs; other URLs unchanged apart from normalisation.
- `img`: `src` kept only when the resolved URL is `https:`; else the image is dropped. Always adds `loading="lazy" referrerpolicy="no-referrer"`.
- Text is re-escaped (`& < > "`); attribute values escaped; a small pre-pass decodes extra named entities that the tokenizer leaves literal (`copy reg trade hellip mdash ndash rarr larr laquo raquo middot bull times ldquo rdquo lsquo rsquo`).
- HTML comments/doctype/processing instructions never reach the output (tokenizer drops them). Output of the sanitizer is re-tokenised in tests and asserted to contain only allowlisted tags and attributes.

## 7. Webview behaviour (`detail.ts`, `detailRender.ts`, `detail.css`)

HTML shell (`buildDetailHtml`): `<div id="detail-root">` containing `#detail-status` (`role="status" aria-live="polite"`), `#detail-error` (`role="alert"`, with Retry button), `<header id="detail-header">`, `<main id="detail-main">`. Script tag `<script nonce src=...>` only.
- States: `idle` -> placeholder "Select a package from the Search view."; `loading` -> loading bar + "Loading <path>…" (also uses the existing `.loading-bar` styling pattern, own copy in detail.css); `error` -> message + Retry (posts `retry`); `ready` -> header + main; `mainLoading` -> bar over the main section; inline error banner + Retry in main when `error` is set with status `ready`.
- Header: title, chips, import path, version link, published, licenses, imports, imported by (text + link buttons), checks list (checked/unchecked marker + text, never colour alone), repository + links, and ONE action button: `Install` when `installed === false`, `Uninstall` when true (`type="button"`, id `detail-action`; click posts `install`/`uninstall`). The `installed` message only updates this button.
- Main: `<section>` README (own title, collapse toggle per decision 13) and `<section>` Documentation with the GOOS `<select>` ("Rendered for", options from `buildContext.options`, value `goos`) rendered only when `buildContext` exists. `change` posts `changeGoos`. Inner HTML set via `container.innerHTML = readmeHtml` (sanitized) only for those two content containers; scoped CSS `.detail-main ...`.
- Event delegation on `#detail-main` and `#detail-header`: `a` click -> `preventDefault`; `href` starting `#` -> `document.getElementById(decodeURIComponent(rest))?.scrollIntoView()`; otherwise post `openLink` with the `href` attribute. Keyboard: native `a`/`button`/`select`, visible focus ring using `--vscode-focusBorder`.
- CSS uses only `--vscode-*` variables (`foreground`, `editor-background`, `textLink-foreground`, `textCodeBlock-background`, `textBlockQuote-*`, `button-*`, `badge-*`, `editorWidget-border`, `focusBorder`, `contrastBorder`, `errorForeground`, `progressBar-background`, `descriptionForeground`, `editor-font-family` for code) and `prefers-reduced-motion`. Images `max-width: 100%`.

## 8. Ordered steps (FEAT summary; detailed steps live in the FEAT json files)

1. FEAT-001 (core scraping pipeline, independent of vscode): `htmlTree.ts`, `htmlSanitize.ts`, `detailUrl.ts`, `packageDetail.ts`, fixtures, unit + property tests, opt-in live smoke test.
2. FEAT-002 (host side; depends on FEAT-001): protocol, messages, controller, html builder, search `select` wiring, panel manager, `extension.ts` wiring, vscode stub, tests.
3. FEAT-003 (webview and build; depends on FEAT-002 protocol): `detailRender.ts`, `detail.ts`, `detail.css`, `esbuild.mjs`, `.gitignore`, `.vscodeignore`, tests, packaging check, manual F5 checklist.

## 9. Verification (exact commands, run from `d:\CODING\AIWorks\goget-manager`)

- After each FEAT: `npm run typecheck` then `npm test` (all existing + new unit tests green). FEAT-003 also `npm run build` (must emit `media/detail.js` and `media/search.js` and `dist/extension.js`) and `npx vsce ls` (must list `media/detail.css` and `media/detail.js`, must not list `sample-pages/` or `.agents/`).
- FEAT-001 live check (needs internet; opt-in test): `$env:GOGET_LIVE='1'; npx vitest --run test/unit/detailLive.test.ts` (parses live `os`, `golang.org/x/sys/unix`, `github.com/spf13/cobra`, `github.com/pkg/errors`; asserts title, version, dropdown presence/absence, no `<script` in output).
- Integration tests (`npm run test:integration`) are not run (need a VS Code download); unchanged API means they should still pass.
- Manual check (cannot be automated here; note in final report as unverified): F5 Extension Development Host; click result A -> a tab opens in the editor area with loading then content; click result B -> same tab updates (no second tab, tab revealed if behind another); close the tab, click again -> opens again; `golang.org/x/sys/unix` or `os` shows dropdown, switching shows loading then new content, `github.com/pkg/errors` shows no dropdown; Install shown for a package not in go.mod, Uninstall for one in go.mod, and the button flips after editing go.mod; offline -> error + Retry; check light, dark and a high-contrast theme.

## 10. Risks / assumptions

- Live HTML may change; selectors sit in one `SELECTORS` table and the parser degrades per field (missing field -> omitted).
- `ViewColumn.Active` is chosen over `One` so the tab opens beside the user's current editor group rather than forcing group 1.
- Remote images in READMEs make network requests from the webview (privacy trade-off, mitigated by `referrerpolicy="no-referrer"`).
- Documentation examples lose their code (textarea skipped by the tokenizer).
- Final URL after a redirect is not exposed by `PkgGoDevSearchClient`; relative links are resolved against the requested URL (correct for the normal 200 case).
