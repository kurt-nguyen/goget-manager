# Single reusable package detail tab backed by pkg.go.dev scraping

Clicking a search result now posts a `select` message with the import path. The host opens one `WebviewPanel` in the editor area, or re-uses and reveals the existing one, and a pure `DetailController` fetches `https://pkg.go.dev/<path>`. The page is parsed into a header model plus sanitized README and Documentation HTML. The webview renders the header with DOM APIs, shows Install or Uninstall as a stub that only logs, and offers a GOOS dropdown that refetches `?GOOS=`. Installed state reuses `installedMatch.ts` and `repository.onDidChange`.

Watch for: (1) the webview rebuilds the whole header and main on every `state` message, because its "same detail" check compares object identity and every real `postMessage` delivers a fresh clone (likely, non-blocking). (2) `npm test` has 1 failure in `searchSmoke.test.ts` that is already present on `main` and untouched by this branch (confirmed). (3) Nothing was run in a real VS Code window, so panel reuse, theming and the live GOOS round trip in the UI are unverified.

**Verdict**: APPROVED

## High-level view

The design follows the repo's existing split. Everything stateful or risky lives in `src/core` with injected dependencies: URL building, the tree builder, the allowlist sanitizer, the scraper, the protocol parser and the controller. `src/vscode/detailPanelManager.ts` is a thin adapter. The branch adds no dependencies, and `src/core` has no `vscode` import.

Single-tab behaviour is implemented as a nullable panel reference. A second click reveals the panel with `preserveFocus` and calls `controller.show`. `onDidDispose` clears the reference, drops the subscriptions and resets the controller, so the next click creates a fresh tab. A `ready` handshake makes a re-created webview receive the full snapshot.

The sanitizer is a real allowlist. It drops dangerous tags with their content, unwraps unknown tags and emits only a fixed attribute set. Ids are prefixed, `javascript:`, `data:` and `vbscript:` hrefs disappear, and images must be https. The CSP uses a nonce with no inline script or style. Every webview message is validated host-side by a parser that never throws.

GOOS handling shows a main-only loading state and keeps the old content with an inline error and Retry on failure. Responses are protected by a generation counter, an `AbortController` and a timeout. The renderer re-creates its DOM more often than intended (see issue 1). The old `open` message and `SearchController.open` still exist and are tested, but the search webview no longer sends `open`.

<details>
<summary>Issues (5)</summary>

1. **Identity check never matches in production** (likely, non-blocking) — `renderedDetail !== detail` in `src/webview/detail.ts` compares object identity, and `postMessage` clones the model each time. Header and main are therefore rebuilt on every `state` message, including the `mainLoading` flip. Compare by a stable key (for example `path` plus `goos`), or skip the rebuild when only `mainLoading` or `error` changed. Also change the "does not rebuild" test, which reuses one object and so hides this.
2. **Pre-existing failing test** (confirmed, non-blocking for this branch) — `searchSmoke.test.ts` "contains no hard-coded colors" flags `transparent` at `media/search.css:199`. The file and the test are identical on `main`. Fix in a separate change, either by dropping the `transparent` fallback or by allowing it in the test.
3. **Unrestricted `openLink` target** (possible, non-blocking) — the host accepts any http, https or mailto URL from the webview and does not check that the page offered it. Impact is limited to opening an external URL from a script-nonce-restricted webview whose content comes from a sanitizer. Optionally restrict to URLs the current model produced.
4. **Parse cost on the extension host** (possible, non-blocking) — `golang.org/x/sys/unix` is a 2.2 MB page, parsed synchronously on the extension host in about 1.3 s (figure recorded in FEAT-001 findings). The 230 KB doc HTML is then posted and set via `innerHTML`. Acceptable for now. Revisit if users report host stalls.
5. **Scraped class names reach the DOM** (possible, non-blocking) — sanitized class tokens are kept, so README HTML containing `class="detail-retry"` would make a click post `retry`, and `hidden` or `is-collapsed` would affect styling. There is no security impact. Prefixing classes the way ids are prefixed would remove the collision.

</details>

<details>
<summary>Details</summary>

## Rebuilding the detail view on every state message

`render()` in `detail.ts` skips the header and main rebuild only when `model.detail === renderedDetail`. VS Code serializes webview messages, so every `state` message carries a new `detail` object. The skip branch is dead code in production, and `setInstalledButton` there is reached only through the separate `installed` message.

The functional result is still correct, because the content is rebuilt from the same data. The cost is visible during a GOOS change. The `mainLoading: true` state re-parses README and Documentation (up to hundreds of KB), the select is destroyed and re-created in a disabled state, and a README the user expanded collapses again. The unit test `does not rebuild header or main when the same detail arrives again` passes one object twice (`send(ready(d)); send(ready(d, {mainLoading:true}))`), so it asserts a behaviour production never reaches.

## Single tab lifecycle

```
Search view --select{path}--> SearchViewProvider --> DetailPanelManager.show(path)
                                                       |-- panel? reveal(undefined, true) : createWebviewPanel(Active)
                                                       '-- controller.show(path)
controller.onDidChange --> postMessage(state) ; webview 'ready' --> snapshot()
panel.onDidDispose --> drop subscriptions, panel = undefined, controller.reset()
```

No serializer is registered, so the tab is not restored after a window reload (documented in the plan). Reset aborts any in-flight request, so a late response cannot repaint a closed tab.

## Sanitizer and CSP posture

I ran an adversarial set against `sanitizeNodes`. The output was safe in every case:

- `javascript:` (including tab-obfuscated forms), `data:` and `vbscript:` hrefs produce an `<a>` with no href.
- `<img>` with `onerror` or a `data:` or `http:` source is dropped or hardened, and `//host` is promoted to https.
- `iframe`, `object`, `embed`, `form`, `svg`, `math`, `noscript`, `style`, `link`, `meta` and `base` are removed with their content.
- `xmp` and mis-nested `<scr<script>ipt>` leave only escaped text.
- `on*`, `style` and `name` attributes are gone, and `id` is emitted as `pd-<id>`.

`JaVaScRiPt&colon;` becomes an ordinary pkg.go.dev URL. Fragment links become `#pd-<encoded id>`. Because the sanitizer re-serializes only allowlisted tags with escaped text and attributes, mutation-XSS through raw-text elements is not reachable. The CSP is `default-src 'none'; style-src <cspSource>; script-src 'nonce-…'; img-src https: data: <cspSource>; font-src <cspSource>`. `detail.ts` assigns HTML in exactly two places (README, Documentation) and never touches `.style`, and a test pins that. `img-src https:` lets READMEs load remote badges and tracking pixels. The plan accepts this and mitigates it with `referrerpolicy="no-referrer"` and `loading="lazy"`.

## Message validation

The detail webview's messages go through `parseDetailMessage`. `changeGoos` requires `^[a-z0-9]{1,16}$`. `openLink` requires a URL of 2048 characters or fewer that parses as http, https or mailto, and the parser returns the normalised href. `javascript:`, `file:`, `command:` and `vscode:` are rejected. The controller additionally honours `changeGoos` only for a value that is one of the current page's options, so a forged GOOS cannot reach the URL builder. The search `select` message must pass `isValidImportPath`. A path with `..` or `?x=1` is rejected. Extra keys are dropped. `openLink` is the one message whose payload is not tied to what the host previously sent (issue 3).

## Installed detection

`extension.ts` builds `isInstalled` from `isInstalledPackage(path, new Set(collectInstalledModulePaths(repository.snapshot())))`, which is the same pair the Search badges use, so `M/vN` handling is consistent. `repository.onDidChange` drives `refreshInstalled()`. It re-evaluates only when status is `ready` and emits a lightweight `installed` message only on change. A load that finishes later computes the flag at settle time, which covers go.mod initialising after the click. The `installed` message updates only the button.

## Test coverage

The new tests cover the parser and tree, the sanitizer (plus a fast-check allowlist property), URL and protocol validation, the controller (stale responses, timeout, abort, retry, GOOS failure, reset, dispose, throwing listener), the panel manager (reuse, dispose and reopen, message routing, failing `openExternal`), the renderer and the view with a fake DOM, and CSS and CSP checks. Fixtures are copied under `test/fixtures/package-detail/`. No test reads the untracked `sample-pages/package_detail*`. The opt-in live test passed 5/5 when I ran it with `GOGET_LIVE=1`. Not tested: a real `postMessage` clone round trip (issue 1), keyboard focus behaviour of the GOOS select, and anything inside a real VS Code instance.

## Build and packaging

`esbuild.mjs` has a third bundle, `src/webview/detail.ts` to `media/detail.js`. `.gitignore` lists `media/detail.js`, and `git ls-files media` shows only `.gitkeep`, `detail.css` and `search.css`. `.vscodeignore` re-includes `media/detail.js` and now excludes `sample-pages/**` and `.agents/**`. `vsce ls` lists `media/detail.css` and `media/detail.js` and neither excluded directory. `package.json` and the lockfile are unchanged, so there are no new dependencies.

</details>

<details>
<summary>File map</summary>

- `src/core/htmlTree.ts`, `htmlSanitize.ts`, `packageDetail.ts`, `detailUrl.ts`: tree builder, allowlist sanitizer, scraper and URL validation (pure)
- `src/core/detailProtocol.ts`, `detailController.ts`, `detailHtml.ts`, `messages.ts`: protocol and parser, state/fetch/GOOS/installed controller, CSP shell, strings
- `src/core/searchProtocol.ts`: adds validated `select` message
- `src/vscode/detailPanelManager.ts`, `searchViewProvider.ts`: single-panel adapter and `select` routing
- `src/extension.ts`: constructs controller and manager, wires `repository.onDidChange`
- `src/webview/detail.ts`, `detailRender.ts`, `render.ts`, `search.ts`: detail view, DOM builders, `data-path`, click posts `select`
- `media/detail.css`: theme-variable styles
- `esbuild.mjs`, `.gitignore`, `.vscodeignore`: third bundle, ignore generated JS, packaging
- `test/unit/*`, `test/fixtures/package-detail/*`, `properties/dt01-*`: new and updated tests and fixtures

Full diff: `git diff main...HEAD` on `feat/detail-tab` (4 commits, 41 files).

</details>

## Verification run by the reviewer

- `npm run typecheck`: exit 0.
- `npm run build`: exit 0. Emits `dist/extension.js`, `media/search.js` and `media/detail.js` (15.2 kb). `git status` lists no generated JS.
- `npm test`: 618 passed, 1 failed (55 files, 54 passed). The failure is `searchSmoke.test.ts` "contains no hard-coded colors in the new rules", reporting `border: 1px solid var(--vscode-contrastBorder, transparent)` from `media/search.css:199`. `git diff main...HEAD` shows no change to that CSS file or that test, so it fails on `main` too.
- `GOGET_LIVE=1 npx vitest run test/unit/detailLive.test.ts`: 5/5 passed against live pkg.go.dev.
- A throwaway adversarial test of the sanitizer and message parsers was run and then deleted. No source files were modified.

## Not verified

- Real VS Code runtime: single-tab reuse with an actual `WebviewPanel`, reveal when the tab is behind another editor, focus behaviour, and whether the first `state` lands before the script loads. Only fakes were exercised.
- The webview in a browser engine: CSP enforcement, `scrollHeight` based README collapse (accepted limitation when hidden), GOOS select interaction.
- Light, dark and high-contrast themes.
- The live GOOS round trip from the UI. The parser was verified against live pages, and the GOOS URL building and controller logic with fakes.
- `npm run test:integration` (needs a VS Code download).
