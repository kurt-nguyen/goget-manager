# Implementation Plan: "Installed" badge on Search_View results

Scope: show a visible "Installed" badge on a search result when its module is already listed in the Installed view (any go.mod, any workspace folder, any version). No new features, no refactors. Do NOT commit. This is one cohesive change across core -> vscode -> webview, so the existing implement/review loop runs it as-is (no FEAT decomposition).

## Findings from exploration (code actually read)

- Search results (`PackageResult.path`) come from pkg.go.dev's `SearchSnippet-header-path`, e.g. `go.mongodb.org/mongo-driver/v2/mongo`, `gopkg.in/mgo.v2`, `github.com/kamva/mgm/v3`, `github.com/mongodb/mongo-tools/common/options`. So `path` is a **package import path**, which may be a sub-package inside a module.
- The Installed view lists `require` entries of each folder's root go.mod: `PackageDependency { path, version }` where `path` is a **module path**. Source of truth: `GoModRepository.snapshot(): InstalledSnapshot` (`src/vscode/goModRepository.ts`), whose `folders[]` hold `FolderGoModState`; only `kind: 'parsed'` states have `dependencies`. `GoModRepository.onDidChange` fires after every (debounced) reload, folder add/remove, and `gogetManager.refresh`. `InstalledTreeProvider` simply re-reads `snapshot()` on that event. Indirect requires (`// indirect`) are listed by the Installed view too (the parser drops comments), so they count as installed.
- `extension.ts` creates `repository`, `searchController`, then `new SearchViewProvider(context.extensionUri, searchController)`. `repository.initialize()` is async and runs after registration, so the first `ready` from the webview can arrive before go.mod files are loaded; a later `onDidChange` must therefore push the set.
- Host -> webview protocol: `HostToWebview` in `src/core/searchProtocol.ts` is currently only `{ type: 'state', state: SearchViewModel }`. Many existing tests pin the `state` message shape and counts (`test/unit/searchViewProvider.test.ts` "posts only the SearchViewModel keys" expects keys `['loading','results','resultsVersion','status']`; "subscribes once per resolve" expects exactly 1 posted message after a submit; "posts the current (empty) state" on `ready`; `test/unit/properties/sp12-webview-messages.test.ts`). `SearchViewProvider` is constructed as `new SearchViewProvider(uri, controller)` in 3 test files.
- Webview rendering: `src/webview/render.ts` `renderState(dom, elements, state)` rebuilds the `<ul>` only when `resultsVersion` changes (WeakMap `renderedVersions`), so status/loading updates never move focus. `buildResult` makes `li > button.result-button` with children `result-path`, `result-name`, `result-desc`; the button has `aria-label=path` (so button content is not read) and `aria-describedby=<desc id>`, so **only content inside `.result-desc` is announced**. `DomLike` offers only `createElement/createTextNode/replaceChildren/setAttribute`. `src/webview/search.ts` handles the window `message` event via `isStateMessage` and calls `renderState`. The test fake `document` in `test/unit/searchView.test.ts` has no `activeElement`, so any new `document.activeElement` use must be guarded.
- CSS: `media/search.css` already uses `--vscode-*` variables; `.result-meta` etc. exist. CSP (`buildSearchHtml`) already has `img-src data:`; no CSP change needed for a text badge.
- Build facts: `package.json` scripts `build` = `node esbuild.mjs`, `typecheck` = `tsc --noEmit -p tsconfig.json`, `test` = `vitest --run` (includes `test/unit/**/*.test.ts` only, `vscode` aliased to `test/unit/vscodeStub.ts`). **Correction to the brief:** `.gitignore` lists `media/search.js` and `dist/`, and `git ls-files media` shows only `media/.gitkeep` and `media/search.css`, so `media/search.js` is a generated, untracked artifact. `npm run build` is still required (to confirm the bundle compiles and to refresh the local artifact) but it will not appear in `git status`.
- Integration tests (`npm run test:integration`, needs a VS Code download) cannot be assumed runnable. Nothing in them needs to change (the test API and tree are untouched).

## Decisions

1. **Matching rule (pure, `src/core/installedMatch.ts`).** A result with package path `P` is installed if some installed module path `M` satisfies `P === M` or `P` starts with `M + '/'` (sub-package of an installed module), compared case-sensitively (Go module paths are case-sensitive), version ignored entirely. Exception: if the first path segment after `M/` is a major-version suffix (`/^v(?:[2-9]|[1-9]\d+)$/`, i.e. `v2`, `v3`, ... `v10`), that `P` belongs to a different Go module (`M/v2` is not `M`), so that prefix does not count (a longer installed prefix such as `M/v2` itself is still matched first). Rationale: exact match alone would miss `github.com/x/y/subpkg` when `github.com/x/y` is required (the common case, since the Installed view lists modules but pkg.go.dev results list packages); naive prefix matching alone would wrongly flag `github.com/x/y/v2` when only v1 is installed, and would need a `/` boundary to avoid `github.com/x/yy`. "Regardless of version" is interpreted as the `version` string in go.mod; `/vN` is part of a Go module's identity, so v1 and v2 are different modules. Assumption noted; keep it.
2. **What counts as the installed set.** All `dependencies[].path` of every `parsed` folder in the `InstalledSnapshot` (single and multi-root, direct and indirect), deduplicated and sorted by code point. `absent`/`parseError`/`readError` folders contribute nothing. The project's own `modulePath` is not included (it is not shown as an installed package). Pure function `collectInstalledModulePaths(snapshot)` in the same core file, reusing `InstalledSnapshot` from `installedModel.ts`; go.mod is NOT re-parsed.
3. **Live update (protocol).** Add a second host -> webview message `{ type: 'installed'; modules: readonly string[] }` to `HostToWebview`. Rationale: leaves the `state` message shape (and the tests pinning it) untouched; installed changes are independent of search state. `SearchViewProvider` gets an **optional** third constructor argument `installed?: InstalledModulesSource` (`{ onDidChange: vscode.Event<void>; modules(): readonly string[] }`, defined and exported in `searchViewProvider.ts`). When provided: on `ready` it posts `installed` first, then `state` (so the first paint is already correct); and it subscribes (stored in `viewSubscriptions`, disposed with the view) to `installed.onDidChange` and posts a fresh `installed` message on every change. When omitted (existing tests), nothing extra is posted, so existing tests stay green. `extension.ts` passes `{ onDidChange: repository.onDidChange, modules: () => collectInstalledModulePaths(repository.snapshot()) }`, which is the same refresh mechanism the Installed tree uses (watchers, debounce, `gogetManager.refresh`, workspace folder changes).
4. **Where matching runs.** In the webview at render time (`renderState` calls `isInstalledPackage` from `src/core`), so a new search and a new installed set both re-apply with no extra host logic. `search.ts` keeps `lastState` and `installed` (a `Set<string>`), re-rendering on either message.
5. **Render.** `renderState(dom, elements, state, installed: ReadonlySet<string> = EMPTY)`. The list is rebuilt when `resultsVersion` changes OR the per-result installed flags change (store `{ version, flags }` in the WeakMap, where `flags` is a string of `'1'`/`'0'` per result). So status/loading updates still never rebuild. The badge is `<span class="result-badge installed-badge">Installed</span>` as the **first child of `.result-desc`** (only present when installed). Rationale: inside `.result-desc` it is announced through `aria-describedby` (the button's `aria-label` hides its other content); the visible label is text, not color alone; no `DomLike` extension needed, so neither fake DOM class changes.
6. **Focus.** A rebuild caused by a go.mod change would drop focus from a focused result button. In `search.ts`'s `installed` handler only: if `document.activeElement` (guarded) is a `.result-button`, remember its `data-index`, and after re-render refocus `.result-button[data-index="N"]` (guarded with optional chaining so the fake test DOM does not break).
7. **Style.** `.result-badge` / `.installed-badge` use `--vscode-badge-background`, `--vscode-badge-foreground`, and a `1px solid var(--vscode-contrastBorder, transparent)` border for high-contrast themes; small pill, `0.85em`.

## Steps

- [ ] 1. Create the pure matching module `src/core/installedMatch.ts`.
      No `vscode` import. Header comment in the style of `installedModel.ts`. Exports:
      ```ts
      import { compareCodePoints } from './compare';
      import type { InstalledSnapshot } from './installedModel';

      /** Module paths of every parsed go.mod, deduplicated, sorted by code point. */
      export function collectInstalledModulePaths(snapshot: InstalledSnapshot): string[] {
        const paths = new Set<string>();
        for (const folder of snapshot.folders) {
          if (folder.kind === 'parsed') {
            for (const dep of folder.dependencies) {
              paths.add(dep.path);
            }
          }
        }
        return [...paths].sort(compareCodePoints);
      }

      const MAJOR_VERSION_SEGMENT = /^v(?:[2-9]|[1-9]\d+)$/;

      /**
       * True when `packagePath` is an installed module or a package inside one.
       * Versions are ignored. `M/vN` is a different module than `M`.
       */
      export function isInstalledPackage(packagePath: string, installed: ReadonlySet<string>): boolean {
        if (installed.has(packagePath)) {
          return true;
        }
        for (let end = packagePath.lastIndexOf('/'); end > 0; end = packagePath.lastIndexOf('/', end - 1)) {
          if (!installed.has(packagePath.slice(0, end))) {
            continue;
          }
          const next = packagePath.slice(end + 1).split('/', 1)[0] ?? '';
          if (!MAJOR_VERSION_SEGMENT.test(next)) {
            return true;
          }
        }
        return false;
      }
      ```
      Verify `compareCodePoints` signature in `src/core/compare.ts` matches `Array.prototype.sort` use (it is used that way in `installedModel.ts`).
      Files: `src/core/installedMatch.ts`
      Verify: `npm run typecheck` passes.

- [ ] 2. Unit-test the matching logic: `test/unit/installedMatch.test.ts` (vitest, same style as `test/unit/installedModel.test.ts`; build snapshots with the same `parsed`-state helper shape used in `test/unit/installedTreeProvider.test.ts`).
      Cases for `collectInstalledModulePaths`: parsed folders only (an `absent`, a `parseError`, a `readError` folder contribute nothing); duplicates across two folders with different versions collapse to one path; result is sorted by code point; empty snapshot -> `[]`.
      Cases for `isInstalledPackage` (set built with `new Set([...])`): exact match; sub-package (`github.com/x/y/sub/pkg` with `github.com/x/y` installed); different version is irrelevant (set holds only paths); `github.com/x/yy` and `github.com/x` are NOT matched by `github.com/x/y` / when only `github.com/x/y` is installed `github.com/x` is false; `github.com/x/y/v2` and `github.com/x/y/v2/sub` NOT matched when only `github.com/x/y` is installed; both ARE matched when `github.com/x/y/v2` is installed; `github.com/x/y/v10/z` not matched by `github.com/x/y`; a non-version segment like `github.com/x/y/vendor/z` or `.../v1/z` IS matched by `github.com/x/y`; `gopkg.in/yaml.v3` matches exactly but `gopkg.in/yaml.v2` does not; case-sensitive (`github.com/X/Y` vs `github.com/x/y` false); empty set -> false; stdlib-like `net/http` -> false.
      Files: `test/unit/installedMatch.test.ts`
      Verify: `npx vitest --run test/unit/installedMatch.test.ts` — all pass.

- [ ] 3. Extend the protocol and the webview renderer (core + webview, depends on step 1).
      - `src/core/searchProtocol.ts`: change `HostToWebview` to
        ```ts
        export type HostToWebview =
          | { readonly type: 'state'; readonly state: SearchViewModel }
          | { readonly type: 'installed'; readonly modules: readonly string[] };
        ```
        (do not touch `SearchViewModel`, `EMPTY_VIEW_MODEL`, `parseWebviewMessage`).
      - `src/webview/render.ts`: import `isInstalledPackage` from `../core/installedMatch`. Add `const NO_INSTALLED: ReadonlySet<string> = new Set();`. Change `renderedVersions` to `WeakMap<object, { version: number; flags: string }>`. Add an optional 4th param `installed: ReadonlySet<string> = NO_INSTALLED` to `renderState`; compute `flags = state.results.map((r) => (isInstalledPackage(r.path, installed) ? '1' : '0')).join('')`; rebuild when `rendered?.version !== state.resultsVersion || rendered.flags !== flags`; pass `flags[index] === '1'` into `buildResult`, then `buildDescription(dom, entry, id, installed)`. In `buildDescription`, when `installed` is true, push `textSpan(dom, 'result-badge installed-badge', 'Installed')` as the FIRST element of `children` (before the synopsis). Update the doc comment of `renderState` (also rebuilt when installed flags change). Nothing else in the file changes (no `innerHTML`, no new `DomLike` methods).
      - `src/webview/search.ts`: add `isInstalledMessage(data): data is Extract<HostToWebview, { type: 'installed' }>` (`type === 'installed'`, `Array.isArray(modules)`, every element `typeof === 'string'`). Keep `let lastState: SearchViewModel | undefined` and `let installed: ReadonlySet<string> = new Set()`. In the `message` listener: for a state message set `lastState` and call `renderState(realDom, elements, lastState, installed)`; for an installed message set `installed = new Set(modules)` and, if `lastState` is defined, remember the focused result index (`const active = document.activeElement as Element | null; const focusedIndex = active?.closest?.('.result-button')?.getAttribute('data-index')` guarded as shown), call `renderState(...)`, then refocus with `results.querySelector?.(`.result-button[data-index="${focusedIndex}"]`)` and `(el as HTMLElement | null)?.focus?.()` only when `focusedIndex` is a digit string (`parseIndex`). All optional-chained so the fake DOM in `test/unit/searchView.test.ts` (no `activeElement`, no `querySelector`) does not throw.
      Files: `src/core/searchProtocol.ts`, `src/webview/render.ts`, `src/webview/search.ts`
      Verify: `npm run typecheck` passes; `npm test` — existing suite still green (render/sp06/searchView tests render without `installed`, so no badge and identical DOM).

- [ ] 4. Badge CSS in `media/search.css`.
      Append after the `.icon-download` rule:
      ```css
      .result-badge {
        display: inline-block;
        margin-bottom: 2px;
        padding: 0 6px;
        font-size: 0.85em;
        line-height: 1.5;
        border: 1px solid var(--vscode-contrastBorder, transparent);
        border-radius: 10px;
      }

      .installed-badge {
        color: var(--vscode-badge-foreground);
        background-color: var(--vscode-badge-background);
      }
      ```
      Files: `media/search.css`
      Verify: `npm test` passes (CSS assertions added in step 6 pass).

- [ ] 5. Wire the installed set into the provider and the extension (vscode layer, depends on steps 1, 3).
      - `src/vscode/searchViewProvider.ts`: export
        ```ts
        /** The slice of the go.mod repository the Search view needs to show Installed badges. */
        export interface InstalledModulesSource {
          readonly onDidChange: vscode.Event<void>;
          modules(): readonly string[];
        }
        ```
        Add optional constructor param `private readonly installed?: InstalledModulesSource`. In `resolveWebviewView` add `const postInstalled = (): void => { const message: HostToWebview = { type: 'installed', modules: this.installed!.modules() }; void Promise.resolve(webview.postMessage(message)).catch(() => undefined); };` (restructure without the non-null assertion, e.g. capture `const installed = this.installed;` and guard). In the `ready` case: `postInstalled()` (when a source exists) BEFORE `post(this.controller.state)`. Add `...(installed ? [installed.onDidChange(postInstalled)] : [])` to the `this.viewSubscriptions.push(...)` list so it is disposed on view dispose, re-resolve, and provider dispose. Keep `toPostedState` and the `state` message unchanged.
      - `src/extension.ts`: import `collectInstalledModulePaths` from `./core/installedMatch`; construct `new SearchViewProvider(context.extensionUri, searchController, { onDidChange: repository.onDidChange, modules: () => collectInstalledModulePaths(repository.snapshot()) })`.
      Files: `src/vscode/searchViewProvider.ts`, `src/extension.ts`
      Verify: `npm run typecheck` passes; `npm test` still green (existing provider tests construct the provider without a source, so no extra messages are posted).

- [ ] 6. Add the remaining tests (depends on steps 3-5).
      - `test/unit/render.test.ts`: reuse its `FakeNode`/`createDom`. (a) With `installed = new Set(['github.com/spf13/cobra'])` and the existing `model()` (cobra, viper): walk `ul > li > button > children[2]` (result-desc): for the cobra entry `desc.children[0]` has `attrs.class === 'result-badge installed-badge'` and a single text child `'Installed'`, followed by the synopsis span; viper's desc has no badge (find by class). (b) A sub-package result `github.com/spf13/cobra/doc` is badged when `github.com/spf13/cobra` is installed; `github.com/spf13/cobra/v2` is not. (c) Rebuild behavior: same `resultsVersion`, rendering with a different `installed` set rebuilds the list once (`listRebuilds()` goes 1 -> 2); rendering again with the same set and a changed `status`/`loading` does not rebuild; rendering with a different set that yields identical flags (e.g. an unrelated module added) does not rebuild. (d) Default call without `installed` produces no `installed-badge` anywhere.
      - `test/unit/searchViewProvider.test.ts`: add a `describe('installed modules')` that builds a provider with a source `{ onDidChange: emitter.event, modules: () => current }` (use `EventEmitter` from `./vscodeStub`). Assert: on `ready` posts `{ type: 'installed', modules }` first and the `state` message second; `emitter.fire()` after changing `current` posts a new `installed` message with the new modules; no `installed` message is posted until `ready`/change when the view is not subscribed; after `view.dispose()` and after re-resolving, firing the emitter posts nothing to the old view and exactly one message to the new view (no accumulated listeners); a provider created without a source never posts `installed`.
      - `test/unit/searchView.test.ts`: in the `search webview script` describe add: a state message followed by an `installed` message containing the result's path re-renders and the `result-desc` contains a child with class `result-badge installed-badge`; an `installed` message arriving before any `state` does not throw and the badge shows once state arrives; a malformed installed message (`modules: [1]` or missing) is ignored. In the `media/search.css` describe add `.result-badge`, `.installed-badge`, `--vscode-badge-background`, `--vscode-badge-foreground` to a new `it.each` of expected tokens.
      - `test/unit/properties/sp12-webview-messages.test.ts`: no change (the provider is constructed without a source there).
      Files: `test/unit/render.test.ts`, `test/unit/searchViewProvider.test.ts`, `test/unit/searchView.test.ts`
      Verify: `npx vitest --run test/unit/render.test.ts test/unit/searchViewProvider.test.ts test/unit/searchView.test.ts` pass, then `npm test` — whole suite green.

- [ ] 7. Update the spec doc (small, no requirements change).
      `.kiro/specs/search-packages/design.md`: where the host/webview messages and the `buildDescription` markup are described, add a short note: the optional `installed` message (`{ type: 'installed', modules }`), the matching rule from Decision 1, and the badge markup `<span class="result-badge installed-badge">Installed</span>` as the first child of `.result-desc`. Edit only the relevant sections; leave `requirements.md` and `tasks.md` alone.
      Files: `.kiro/specs/search-packages/design.md`
      Verify: re-read the edited lines; `npm test` still passes.

- [ ] 8. Full verification (run in order, all must exit 0).
      `npm run typecheck`, `npm test`, `npm run build`. `npm run build` bundles `src/webview/search.ts` into `media/search.js` (gitignored, so it will not show in `git status`; confirm the file contains `installed-badge` as a check that the bundle is fresh) and `src/extension.ts` into `dist/extension.js` (also gitignored). Confirm `git status --short` lists only the source, test, CSS and design-doc files from the steps above (and no `package.json` changes).
      Files: none (generated, ignored artifacts)
      Verify: the three commands exit 0.

## Notes / limits

- Not verified headlessly: real-webview rendering (badge appearance across light/dark/high-contrast themes), live refresh when go.mod is edited in a running VS Code, and screen reader announcement. Recommend a manual check in the Extension Development Host (F5): open a folder whose go.mod requires e.g. `github.com/spf13/cobra`, search `cobra` (badge on `github.com/spf13/cobra` and on its sub-packages), edit go.mod to remove the require (badge disappears without a new search), and add a second folder with another go.mod (multi-root).
- `npm run test:integration` needs a VS Code download and may not be runnable; no integration test was changed. The `testApi` is intentionally unchanged.
- The Installed view lists direct and indirect requires; the badge follows that list exactly. Replace directives and the workspace's own module path are out of scope.
