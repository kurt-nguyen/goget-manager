# Implementation Plan: Search Packages

## Overview

Build the feature in TypeScript, bottom-up, on top of the existing extension. First the pure core in `src/core/`: the query URL builder and URL allow-list, the HTML tokenizer and results parser, the search outcome types, the extended messages, the result view model, the webview message protocol, and the `SearchController`. Each core module gets its property and unit tests right after it. Then the VS Code adapter layer (`PkgGoDevSearchClient` and `nodeHttpsTransport`), the webview renderer and script, the extended `SearchViewProvider`, wiring in `extension.ts` and `testApi.ts`, and finally smoke and integration tests.

Tests use the existing tooling unchanged: Vitest (`npm test`) with fast-check `4.10.2`, the `vscode` alias to `test/unit/vscodeStub.ts`, and `@vscode/test-cli` + Mocha for integration tests. Each property test lives in its own file `test/unit/properties/sp<NN>-<slug>.test.ts`, runs at least 100 iterations (200 for the parser properties), and carries the tag comment `// Feature: search-packages, Property N: <title>`. No new dependencies are added.

## Tasks

- [x] 1. Implement the query URL builder and URL allow-list
  - [x] 1.1 Implement `src/core/searchQuery.ts`
    - Export `PKG_GO_DEV_HOST`, `toSearchQuery` (clamp to 256 code points with `clampSearchText`, then `trim()`), `encodeQueryComponent`, `buildSearchUrl`, `isPkgGoDevHttpsUrl`, `packagePageUrl`, and the `SearchUrlResult` / `PackageUrlResult` types from the design
    - `encodeQueryComponent`: replace lone surrogates with U+FFFD, encode with `TextEncoder`, keep only `A-Z a-z 0-9 - . _ ~` literal, write every other byte as `%` + two uppercase hex digits (space → `%20`, `+` → `%2B`)
    - `buildSearchUrl` concatenates `'https://pkg.go.dev/search?q=' + encoded + '&m=package'` (no `URLSearchParams`) and returns `{ ok: false, reason: 'empty' }` for `''`
    - `isPkgGoDevHttpsUrl`: WHATWG `URL` parse succeeds, protocol `https:`, hostname `pkg.go.dev`, port empty or `443`, no username or password; never throws
    - `packagePageUrl(path)`: `emptyPath` for `''`, otherwise `https://pkg.go.dev/` + path checked with `isPkgGoDevHttpsUrl` (`notPkgGoDev` when it fails)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.4, 8.2_

  - [x] 1.2 Write property test for the search URL
    - File: `test/unit/properties/sp01-search-url.test.ts`; generate well-formed queries of 1–256 code points biased toward `& = # + % ? / space`, `!'()*`, non-ASCII, and astral characters (local generator; task 2.4 later moves shared generators to `searchArbitraries.ts`)
    - **Property 1: Search URL structure and query round trip**
    - **Validates: Requirements 2.1, 2.3, 2.4**

  - [x] 1.3 Write property test for query encoding
    - File: `test/unit/properties/sp02-query-encoding.test.ts`
    - **Property 2: Query encoding uses only unreserved characters and uppercase UTF-8 escapes**
    - **Validates: Requirements 2.2**

  - [x] 1.4 Write unit tests for the URL builder and allow-list
    - File: `test/unit/searchQuery.test.ts`: `buildSearchUrl('')` → `{ ok: false, reason: 'empty' }`; `mongodb` → `https://pkg.go.dev/search?q=mongodb&m=package`; `a b+c&d=e#f` → `q=a%20b%2Bc%26d%3De%23f`; a lone surrogate → `%EF%BF%BD`; `toSearchQuery` trims and clamps; `isPkgGoDevHttpsUrl` rejects `http:`, port `8443`, credentials, `pkg.go.dev.evil.com`, and unparsable input; `packagePageUrl('')` → `emptyPath`
    - _Requirements: 2.1, 2.2, 2.5, 5.4, 8.2_

- [x] 2. Implement the HTML tokenizer and results parser
  - [x] 2.1 Implement `src/core/htmlTokens.ts`
    - Export `HtmlToken`, `tokenizeHtml(html)` (lazy `Iterable`, single `indexOf`-driven pass, never throws), and `decodeCharacterReferences(text)`
    - Rules from the design: literal `<` when not followed by `/`, `!`, `?`, or an ASCII letter; `<!--` to `-->`; `<!…>` and `<?…>` to `>`; lowercased tag and attribute names; double-quoted, single-quoted, and unquoted attribute values, entity-decoded; trailing `/` sets `selfClosing`; raw-text skipping for `script`, `style`, `textarea`, `title` up to the case-insensitive matching end tag; an unterminated tag, comment, or quoted value drops the partial tag and ends tokenization
    - Decode `&amp; &lt; &gt; &quot; &apos; &nbsp;`, `&#NNN;`, `&#xHH;`; out-of-range or surrogate code points become U+FFFD; unknown named references stay literal
    - _Requirements: 3.1, 3.4, 3.8_

  - [x] 2.2 Implement `src/core/resultsParser.ts`
    - Export `PackageResult` and `parseSearchResults(html)`; keep all selectors in one `SELECTORS` constant taken from `sample-pages/SearchResults.html` (`SearchSnippet` entry, `data-test-id="snippet-title"` link with the `h2 > a` fallback, `SearchSnippet-header-path`, `SearchSnippet-synopsis`, `SearchSnippet-infoLabel`, imported-by link via `tab=importedby` or `aria-label="Go to Imported By"`, `snippet-published`, `snippet-license`)
    - Single pass over `tokenizeHtml` with an open-element stack: void and self-closing elements not pushed; an end tag pops to the nearest matching open element, unmatched end tags ignored; an entry is finalized when its `div` pops, the next entry starts, or input ends
    - Field captures start when their element opens and complete when it pops; the name capture pauses inside the path span; the version is the first `strong` in the info label outside the imported-by link, the published element, and the license element; captures open at end of input are discarded; only the first completed capture per field is kept
    - Normalize: collapse `/\s+/gu` to one space and trim; for the path, strip one leading `(` and one trailing `)` and trim again; emit an entry only with a non-empty, whitespace-free path and a non-empty name; omit optional fields that normalize to empty; keep duplicates and page order
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 2.3 Write unit tests for the tokenizer
    - File: `test/unit/htmlTokens.test.ts`: start, end, and self-closing tags with each attribute quoting style; comments and `<!DOCTYPE>`; raw-text skipping of `script`/`style` containing fake tags; each supported named and numeric reference including `&#34;`, `&#39;`, `&#43;`; invalid numeric reference → U+FFFD; unknown named reference stays literal; unterminated tag, comment, and quoted value end tokenization without throwing
    - _Requirements: 3.4, 3.8_

  - [x] 2.4 Create shared search generators and the test page renderer
    - File: `test/unit/searchArbitraries.ts`: query and box-text generators (move the local query generator from 1.2 here and import it there), the entry spec generator (optional fields absent, empty, whitespace-only, or a value with `<`, `>`, `&`, quotes, `Imported by`, `published on`, and whitespace runs), invalid entry specs (missing path span, empty or whitespace-only path, path with whitespace, missing or empty name), and the page renderer producing `sample-pages/SearchResults.html` markup with noise (indentation, extra attributes and classes, random character references, inline wrapper tags inside values, "Other major versions" and "Other packages in module" blocks with `strong` elements, comments, and `script`/`style` blocks with fake `SearchSnippet` markup)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 2.5 Write property test for parsing rendered pages
    - File: `test/unit/properties/sp03-parse-results.test.ts`; 200 runs
    - **Property 3: Parsing a rendered results page returns its entries**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

  - [x] 2.6 Write property test for invalid entries
    - File: `test/unit/properties/sp04-parse-invalid.test.ts`; 200 runs
    - **Property 4: Invalid entries are dropped without disturbing the rest**
    - **Validates: Requirements 3.6**

  - [x] 2.7 Write property test for parser totality
    - File: `test/unit/properties/sp05-parse-total.test.ts`; 200 runs; use `fc.string({ unit: 'binary' })` for arbitrary text and `fc.nat` cut offsets over rendered pages, asserting the cut page's paths are a prefix of the uncut page's paths
    - **Property 5: The parser is total and its output is well formed on any input**
    - **Validates: Requirements 3.7, 3.8, 3.9**

  - [x] 2.8 Write parser unit tests with page fixtures
    - Copy `sample-pages/SearchResults.html` to `test/fixtures/search-results/sample.html`, and add hand-made `no-results.html` and `unterminated.html` (unterminated tag inside the third entry)
    - File: `test/unit/resultsParser.test.ts`: the sample yields 25 results, the first equal to `{ path: 'go.mongodb.org/mongo-driver/v2/mongo', name: 'mongo', synopsis: 'Package mongo provides a MongoDB Driver API for Go.', version: 'v2.9.2', published: 'Oct 6, 2026', importedBy: '1,289' }`, and the `github.com/kamva/mgm/v3` entry has no synopsis; `''` and the no-results page return `[]`; the unterminated page keeps the first two entries; `Oct  6, 2026` normalizes to `Oct 6, 2026`; a synthetic 5 MB page parses in under 1 s
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement messages, the result view model, and the webview protocol
  - [x] 4.1 Declare the search outcome types in `src/core/searchController.ts`
    - Create the file with only the exported types `SearchFailure`, `SearchResponse`, and `SearchClient` from the design (the class is added in task 5.1), so `messages.ts` and the adapter can import them with `import type`
    - _Requirements: 6.3, 6.4, 6.5, 8.3_

  - [x] 4.2 Extend `src/core/messages.ts` with search texts and log lines
    - Add `SEARCHING` (`Searching…`, U+2026), `resultCount(n)`, `noResults(query)`, `UNREACHABLE`, `httpError(status)`, `TIMED_OUT`, `openFailedNotification(path)`, `searchFailureLog(ts, query, failure)`, `openRefusedLog(ts, path, reason)`, and `openFailedLog(ts, path, reason)` with the exact texts and log formats from the design
    - Quote the query and path with `JSON.stringify` so every log line is a single line; the `redirectBlocked` line includes both `HTTP error <status>` and the target host
    - Keep the existing exports unchanged
    - _Requirements: 4.5, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.4_

  - [x] 4.3 Implement `src/core/resultView.ts`
    - Export `MAX_SYNOPSIS = 300`, `ResultEntry`, `truncateSynopsis(text, max = 300)` (reuse `clampSearchText`; append `…` only when the text is longer than `max` code points), and `toResultEntry(result)` (copies fields, truncates the synopsis, never adds absent fields)
    - Keep the module free of Node and `vscode` imports, since it is bundled into the webview
    - _Requirements: 4.3, 4.8_

  - [x] 4.4 Implement `src/core/searchProtocol.ts`
    - Export `SearchViewModel`, `WebviewToHost`, `HostToWebview`, `EMPTY_VIEW_MODEL` (`{ results: [], status: '', loading: false, resultsVersion: 0 }`), and `parseWebviewMessage(value)`
    - `parseWebviewMessage` never throws; accepts only `ready`, `query`/`submit` with a string `text` (clamped to 256 code points), and `open` with non-negative integer `resultsVersion` and `index`; returns new objects with only the allowed keys; returns `undefined` for anything else
    - _Requirements: 8.7_

  - [x] 4.5 Write unit tests for messages and the view model
    - File: `test/unit/searchMessages.test.ts`: every status text and log line format from the design table (`resultCount(1)` → `1 result`, `resultCount(2)` → `2 results`, a query with `"` and `\n` stays on one line); `truncateSynopsis` at 299, 300, and 301 code points and with an astral character at the boundary; `toResultEntry` omits absent fields; `parseWebviewMessage` rejects unknown types, non-string text, negative or fractional numbers, and non-objects
    - _Requirements: 4.3, 4.5, 4.8, 6.2, 6.3, 6.4, 6.5, 6.6, 8.4, 8.7_

- [x] 5. Implement the search controller
  - [x] 5.1 Implement the `SearchController` class in `src/core/searchController.ts`
    - Add `SearchControllerDeps` and the class with `state`, `onDidChangeState`, `queryChanged`, `submit`, `open`, and `dispose`; declare structural `OutputLike` and `DisposableLike` interfaces in core (compatible with the ones in `src/vscode/goModRepository.ts`) so the file imports only from `src/core`
    - Use `KeyedDebouncer` with the injected `TimerApi` (default 400 ms) and a 10 s timeout timer per search; track `generation`, `inFlight` (`generation`, `query`, `AbortController`, timer), and `lastStarted` (`query`, `outcome`)
    - `queryChanged`: empty Search_Query → cancel the debounce, abort in-flight, clear `lastStarted`, set the empty state; otherwise schedule `start(q)`, skipped at fire time when `lastStarted.query === q` with outcome `pending` or `ok`; never change visible state for non-empty text
    - `submit`: cancel the debounce; no-op for an empty Search_Query; otherwise `start(q)` immediately even for the same query
    - `start`: abort and clear in-flight first, `generation++`, emit `loading: true` and `SEARCHING` with the previous results synchronously, arm the timeout, call `client.search(buildSearchUrl(q).url, signal)` exactly once
    - Settlement only for the current generation: `ok` → `parseSearchResults`, `resultCount` or `noResults`; failures → empty results, failure status, exactly one `searchFailureLog` line with `now().toISOString()`; timeout aborts the request and settles as `timeout`; `aborted` is ignored; always `loading: false` and `resultsVersion++`; never call `showError` for search failures
    - `open(version, index)`: ignore stale versions and out-of-range indexes; `packagePageUrl` refusal → one `openRefusedLog` line; valid → `openExternal`; `false` or rejection → `showError(openFailedNotification(path))` and one `openFailedLog` line; never modify state
    - Call listeners inside `try/catch` and log listener errors with the stack; `dispose` aborts in-flight and clears the debounce and timer
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.1, 4.5, 4.6, 4.7, 5.1, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7.1, 7.5, 8.3, 8.4, 8.5_

  - [x] 5.2 Create shared controller test helpers
    - Move the `FakeTimers` class from `test/unit/properties/p13-debouncer.test.ts` to `test/unit/fakeTimers.ts` and import it back into `p13-debouncer.test.ts` without changing that test's behavior
    - Add to `test/unit/searchArbitraries.ts`: a deferred-based fake `SearchClient` that records each `search(url, signal)` call, a recording `OutputLike`, a fixed clock, and the event script generator (`query(text)`, `submit(text)`, `advance(ms)`, `settle(searchIndex, outcome)` with `ok(html)`, each failure kind, or `aborted`, targeting any earlier search in any order)
    - _Requirements: 1.1, 1.2, 1.3, 6.9_

  - [x] 5.3 Write property test for when searches start
    - File: `test/unit/properties/sp07-search-start.test.ts`; compare the started searches against a reference model driven by the same event script on `FakeTimers`
    - **Property 7: Searches start only as typing, Enter, and clearing dictate**
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6, 4.6**

  - [x] 5.4 Write property test for latest-search-wins
    - File: `test/unit/properties/sp08-latest-wins.test.ts`
    - **Property 8: The latest search wins and at most one request is in flight**
    - **Validates: Requirements 1.3, 4.7, 6.1, 6.5, 6.9, 8.5**

  - [x] 5.5 Write property test for search outcomes
    - File: `test/unit/properties/sp09-search-outcomes.test.ts`; assert status texts against literal templates, not the `messages.ts` helpers
    - **Property 9: Search outcomes map to the exact view state and one log line**
    - **Validates: Requirements 4.5, 6.2, 6.3, 6.4, 6.6, 6.7, 8.3, 8.4**

  - [x] 5.6 Write property test for opening package pages
    - File: `test/unit/properties/sp11-open-package.test.ts`; cover `packagePageUrl` over arbitrary strings and Go import path characters, and `SearchController.open` with a recording `openExternal`
    - **Property 11: Package pages open only as HTTPS pkg.go.dev URLs built from the displayed path**
    - **Validates: Requirements 5.1, 5.4**

  - [x] 5.7 Write controller unit tests
    - File: `test/unit/searchController.test.ts`: a new controller has `EMPTY_VIEW_MODEL` and makes no client call; an empty Enter changes nothing; Enter after a failure re-searches the same query; the timeout counts from search start; clearing during a search aborts it and clears the state; `openExternal` returning `false` and rejecting each produce one notification and one log line with the state unchanged; a stale `resultsVersion` is ignored; a throwing listener does not stop other listeners
    - _Requirements: 1.5, 1.6, 5.5, 6.5, 6.7, 6.8, 7.6_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the search client and HTTPS transport
  - [x] 7.1 Implement `PkgGoDevSearchClient` in `src/vscode/searchClient.ts`
    - Export `RawHttpResponse`, `HttpTransport`, `REQUEST_HEADERS` (`Accept: text/html`, `Accept-Encoding: identity`, `User-Agent: goget-manager-vscode`), `MAX_BODY_BYTES` (5 MiB), `MAX_REDIRECTS` (5), and `PkgGoDevSearchClient`
    - `search(url, signal)` never rejects: refuse a non-allowed initial URL as `unreachable` without sending; 2xx → `ok`; 301/302/303/307/308 with `Location` → resolve with `new URL(location, current)`, follow only when `isPkgGoDevHttpsUrl` passes and fewer than 5 hops were followed, otherwise `redirectBlocked` with the redirect status and target host (`(invalid URL)` when unparsable) or `http` when the hop limit is exceeded; other statuses → `http`; transport rejection → `aborted` when `signal.aborted`, otherwise `unreachable` with the error `code` or message
    - _Requirements: 6.3, 6.4, 8.1, 8.2, 8.3_

  - [x] 7.2 Implement `nodeHttpsTransport` in `src/vscode/searchClient.ts`
    - `https.request(url, { method: 'GET', headers, signal })` with no agent override (so VS Code proxy settings apply) and no redirect following
    - Collect chunks up to `maxBodyBytes`, then destroy the request and resolve with the truncated body; decode as UTF-8; return `status` and `location`
    - Reject on `error`, and on `aborted` or `close` before `end`
    - _Requirements: 1.4, 6.3, 8.1, 8.2_

  - [x] 7.3 Write property test for the search client
    - File: `test/unit/properties/sp10-search-client.test.ts`; drive `PkgGoDevSearchClient` with a recording fake `HttpTransport` and generated response chains (2xx, non-2xx, redirects with relative, absolute, other-host, `http:`, non-default port, credentials, lookalike `pkg.go.dev.evil.com`, and malformed `Location` values); no sockets
    - **Property 10: The search client contacts only HTTPS pkg.go.dev with fixed headers**
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [x] 7.4 Write unit tests for the client and transport
    - File: `test/unit/searchClient.test.ts`: a 3xx without `Location` → `http`; six same-host redirects → `http` with the last status; an aborted signal → `aborted`; `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET` → `unreachable` with the code; with `https.request` stubbed via `vi.spyOn`, the body is capped at `MAX_BODY_BYTES`, `close` before `end` rejects, and the request options carry `REQUEST_HEADERS` and no redirect option
    - _Requirements: 6.3, 6.4, 8.1, 8.2, 8.3_

- [x] 8. Implement the webview renderer, script, and styles
  - [x] 8.1 Implement `src/webview/render.ts`
    - Define the small `DomLike` interface (`createElement`, `createTextNode`, `replaceChildren`, `setAttribute`, `textContent`, `hidden`) and `renderState(dom, elements, state)`
    - Rebuild the Result_List only when `resultsVersion` changes: one `<li class="result">` with a `<button type="button" class="result-button">` per result, `aria-label` = path, `aria-describedby`, `data-version`, `data-index`, then the path span first, the name span, and the description span with synopsis (`toResultEntry`), version, a `published` span (calendar icon span with title 'Publish date', then the value), and an `importedBy` span (download icon span with title 'Number of import', then the value); every value is its own text node; no span for absent fields; never use `innerHTML`
    - Assign the status `textContent` only when the text differs; set the loading element's `hidden = !state.loading`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.8, 5.2, 5.3, 7.4_

  - [x] 8.2 Extend `src/webview/search.ts` and update the existing webview script tests
    - On load: restore text from `getState()` as before, then post `{ type: 'ready' }` (a restored text does not start a search)
    - `input`: save clamped text, then post `{ type: 'query', text }`; Enter `keydown` when not `isComposing`: `preventDefault()` and post `{ type: 'submit', text }`; `message` with `{ type: 'state' }` → `renderState`; result button `click` → post `{ type: 'open', resultsVersion, index }` from the `data-` attributes
    - In `test/unit/searchView.test.ts`, extend the fake `document` with the `#loading`, `#status`, and `#results` elements and the window `message` listener, and replace the "never calls postMessage" test (superseded by this feature) with tests that `ready` is posted on load and `input` posts `query`; keep the existing restore, clamp, and Enter `preventDefault` tests passing
    - _Requirements: 1.1, 1.6, 5.1, 7.2, 7.6, 8.7_

  - [x] 8.3 Extend `media/search.css`
    - Result list, result button, path (larger, bold), name, description, and meta styles using only `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-list-hoverBackground`, and `--vscode-list-activeSelectionBackground`
    - `.result-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }`
    - Status line with `--vscode-descriptionForeground`; indeterminate loading bar with `--vscode-progressBar-background` and a `@media (prefers-reduced-motion: reduce)` static fallback; no hard-coded colors in the new rules
    - _Requirements: 4.2, 5.2, 7.3_

  - [x] 8.4 Write property test for result rendering
    - File: `test/unit/properties/sp06-render-results.test.ts`; render into a fake DOM that records created tags, text nodes, attributes, and any `innerHTML` write
    - **Property 6: Results render as complete, ordered, plain-text entries**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.8, 5.3**

  - [x] 8.5 Write unit tests for the renderer and webview script
    - File: `test/unit/render.test.ts`: the same status rendered twice assigns `textContent` once; the list is not rebuilt when only `status` or `loading` change; the loading element toggles `hidden`
    - In `test/unit/searchView.test.ts`: Enter posts one `submit` and calls `preventDefault`, but posts nothing while `isComposing`; a result `click` posts exactly one `open` with the right version and index; a `state` message renders results and status
    - _Requirements: 1.1, 4.6, 5.1, 7.4_

- [x] 9. Wire the provider, extension, and test API
  - [x] 9.1 Extend `src/vscode/searchViewProvider.ts`
    - Add the `#loading` (`hidden`, `aria-hidden="true"`), `#status` (`role="status"`, `aria-live="polite"`), and `#results` (`aria-label="Search results"`) elements after the input in `buildSearchHtml`, keeping the CSP and the single input unchanged
    - Constructor takes the `SearchController`; on resolve, relay `onDidReceiveMessage` through `parseWebviewMessage` (drop invalid messages): `ready` → post the current state, `query` → `queryChanged`, `submit` → `submit`, `open` → `open`
    - Subscribe to `controller.onDidChangeState` and post `{ type: 'state', state }` with only the `SearchViewModel` keys to the currently resolved view; dispose subscriptions when the view is disposed or re-resolved; add `dispose()`
    - _Requirements: 6.1, 7.2, 7.4, 7.5, 7.6, 8.7_

  - [x] 9.2 Wire `src/extension.ts` and extend `src/vscode/testApi.ts`
    - In `activate`, create `PkgGoDevSearchClient(nodeHttpsTransport)` and a `SearchController` with the existing output channel, `openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true))`, and `showError: (m) => void vscode.window.showErrorMessage(m)`; pass the controller to `SearchViewProvider`; push the controller and provider into `context.subscriptions`
    - Add `getSearchState(): SearchViewModel` to `GogetManagerApi`, and `submitSearchForTest(text)` only when `context.extensionMode === vscode.ExtensionMode.Test`
    - Leave `GoModRepository` and `InstalledTreeProvider` untouched; confirm `npm run build` and `npm run typecheck` succeed
    - _Requirements: 5.1, 5.5, 6.6, 7.1, 8.6_

  - [x] 9.3 Write property test for the webview message boundary
    - File: `test/unit/properties/sp12-webview-messages.test.ts`; check `parseWebviewMessage` over `fc.jsonValue()` and crafted near-valid messages, and the keys of messages posted by `SearchViewProvider` (with a fake webview) for generated controller states
    - **Property 12: Messages across the webview boundary carry only allowed data**
    - **Validates: Requirements 8.7**

  - [x] 9.4 Write provider unit tests
    - File: `test/unit/searchViewProvider.test.ts`, extending `test/unit/vscodeStub.ts` with any members the fake webview view needs: `buildSearchHtml` contains hidden `#loading`, `#status` with `role="status"` and `aria-live="polite"`, and `#results`, keeps the CSP with no `connect-src`, and has exactly one input; `ready` posts the current state; invalid messages are ignored; a state change while hidden is delivered; a re-resolved view that sends `ready` receives the outcome of a search that finished meanwhile
    - _Requirements: 7.2, 7.4, 7.5, 7.6, 8.7_

  - [x] 9.5 Write smoke tests for styles and network use
    - File: `test/unit/searchSmoke.test.ts`: `media/search.css` has a `.result-button:focus-visible` rule using `--vscode-focusBorder` and references `--vscode-progressBar-background`, `--vscode-descriptionForeground`, and `--vscode-list-hoverBackground`, with no hard-coded color values in the new rules; a scan of `src/**/*.ts` finds `node:https`, `https`, `http`, `net`, or `tls` imports only in `src/vscode/searchClient.ts` and no `fetch(`, `XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon`
    - _Requirements: 5.2, 7.3, 8.6_

  - [x] 9.6 Write integration tests in the VS Code host
    - File: `test/integration/search.test.ts`; add a `configFor('search', scratchCopy('single-folder'))` entry to `.vscode-test.mjs`
    - After activation the Search view resolves and `getSearchState()` equals the empty model with `loading: false`
    - Opt-in live test, skipped unless `GOGET_LIVE_SEARCH=1`: `submitSearchForTest('mongodb')` yields at least one result within 15 s including a `mongo` package, and `getInstalledTree()` is identical before and after
    - _Requirements: 1.5, 7.1, 7.6_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Task 8.2 is not optional because it replaces the existing "never calls postMessage" test, which this feature makes obsolete.
- Optional property tests 2.5–2.7 and 5.3–5.6 depend on the optional generator and helper tasks 2.4 and 5.2.
- Requirements 5.2 (visible focus), 7.3 (theme switch), and the screen reader parts of 5.3 and 7.4 also need the design's manual verification checklist. Full accessibility validation requires testing with assistive technologies.
- Each property test maps to one correctness property in the design; unit tests cover the specific examples and edge cases from the testing strategy.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.2", "2.3", "4.2"] },
    { "id": 2, "tasks": ["2.4", "4.3", "4.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "2.8", "4.5", "5.1", "7.1", "8.1"] },
    { "id": 4, "tasks": ["5.2", "7.2", "8.2", "8.3", "9.1"] },
    { "id": 5, "tasks": ["5.3", "5.4", "5.5", "5.6", "5.7", "7.3", "7.4", "8.4", "8.5", "9.2"] },
    { "id": 6, "tasks": ["9.3", "9.4", "9.5", "9.6"] }
  ]
}
```
