# Implementation Plan: Goget Manager Extension

## Overview

Build the extension in TypeScript, bottom-up. First the scaffolding and manifest. Next the pure core in `src/core/`: comparator, messages, search-text clamp, debouncer, go.mod parser, require printer, installed-tree model, and tree-item props. Each core module gets its property tests right after it. Then the VS Code adapter layer (`GoModRepository`, `InstalledTreeProvider`), the Search webview, wiring in `extension.ts`, and integration tests in a real VS Code host.

Property tests use Vitest + fast-check, at least 100 runs each. Each one carries the tag comment `// Feature: goget-manager-extension, Property N: <title>`. Each property test lives in its own file under `test/unit/properties/` so tasks don't edit the same file.

## Tasks

- [x] 1. Set up project scaffolding and extension manifest
  - [x] 1.1 Create project structure, build, and test tooling
    - Create `package.json` with the manifest from the design: `name`, `displayName`, `engines.vscode ^1.85.0`, `main: ./dist/extension.js`, empty `activationEvents`, one `activitybar` container (`id: goget-manager`, `title: Goget Manager`, `icon: imgs/goget-manager-icon.png`, no `when`), views `gogetManager.search` (type `webview`, name `Search`) and `gogetManager.installed` (name `Installed`) in that order, command `gogetManager.refresh` (title `Refresh`, icon `$(refresh)`, category `Goget Manager`), and a `view/title` menu entry for `view == gogetManager.installed` in group `navigation`
    - Add scripts: `build`, `watch`, `typecheck`, `test` (`vitest --run`), `test:integration` (`vscode-test`), `package` (`vsce package`)
    - Pin exact devDependency versions: `typescript`, `esbuild`, `vitest`, `fast-check`, `@types/vscode`, `@types/node`, `@types/mocha`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`
    - Create `tsconfig.json` (strict, ES2022, Node16 module resolution), `esbuild.mjs` that bundles `src/extension.ts` to `dist/extension.js` with `vscode` external, `.vscodeignore`, and `.gitignore`
    - Create `vitest.config.ts` that includes `test/unit/**/*.test.ts` and aliases `vscode` to `test/unit/vscodeStub.ts`, and create a minimal `vscodeStub.ts` (`EventEmitter`, `Uri`, `ThemeIcon`, `TreeItem`, `TreeItemCollapsibleState`, `FileSystemError`)
    - Create the folders `src/core`, `src/vscode`, `src/webview`, `media`, `test/unit/properties`, `test/integration`, `test/fixtures`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 6.3_

  - [x] 1.2 Write manifest smoke tests
    - In `test/unit/manifest.test.ts`, read `package.json` and assert: exactly one `activitybar` container with the expected id, title, and icon and no `when`; views in order Search (webview) then Installed, neither with `visibility: "collapsed"`; the refresh command and its `view/title` menu binding; `imgs/goget-manager-icon.png` exists on disk
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.8, 2.1, 2.2, 2.3, 2.5, 6.3_

- [x] 2. Implement core utilities
  - [x] 2.1 Implement `src/core/compare.ts` and `src/core/messages.ts`
    - `compareCodePoints(a, b)` walks both strings with `codePointAt`, advancing 1 or 2 code units per code point; a proper prefix sorts first
    - `messages.ts` exports `NO_FOLDER`, `NO_GO_MOD`, `NO_PACKAGES`, `parseError(path, line | undefined, msg)` (omits the line segment when no line is given), and `readError(path, reason)` with the exact texts from the design
    - _Requirements: 5.4, 7.1, 7.2, 7.3, 7.4, 7.6_

  - [x] 2.2 Write property test for the code point comparator
    - File: `test/unit/properties/p07-compare.test.ts`
    - **Property 7: Code point comparator matches a reference ordering**
    - Include astral-plane characters in the generators
    - **Validates: Requirements 5.4**

  - [x] 2.3 Implement `src/core/searchText.ts`
    - `clampSearchText(text, max = 256)` keeps the first `max` code points and never splits a surrogate pair
    - _Requirements: 3.3, 3.6_

  - [x] 2.4 Write property test for search text clamping
    - File: `test/unit/properties/p06-search-clamp.test.ts`
    - **Property 6: Search text clamping keeps the first 256 characters**
    - **Validates: Requirements 3.3, 3.6**

  - [x] 2.5 Implement `src/core/debouncer.ts`
    - `KeyedDebouncer<K>` with an injectable `TimerApi` and the methods `schedule`, `flush`, `cancel`, and `dispose`; at most one pending callback per key; rescheduling replaces the callback and restarts the delay
    - _Requirements: 6.7_

  - [x] 2.6 Write property test for the keyed debouncer
    - File: `test/unit/properties/p13-debouncer.test.ts`; define the schedule-sequence generator locally in this file and drive it with a fake `TimerApi`
    - **Property 13: Debouncer runs only the last scheduled callback per key**
    - **Validates: Requirements 6.7**

- [x] 3. Implement the go.mod parser and require printer
  - [x] 3.1 Implement `src/core/goModParser.ts`
    - Export `PackageDependency`, `ParseSuccess`, `ParseFailure`, `GoModParseError`, `ParseResult`, and `parseGoMod(text)`
    - Tokenizer: strip a leading BOM, split on `\n`, drop a trailing `\r`; space/tab separators; a token that starts with `//` starts a comment; `"..."` strings with `\"`/`\\` escapes; `` `...` `` raw strings; an unterminated quote is an error on that line
    - State machine (TopLevel, RequireBlock, OtherBlock): single-line `require` needs exactly two tokens; a block opens only on the exact tokens `require (` / `<verb> (`, and `require ()` is an empty block; a block closes only on a line whose sole token is `)`; other blocks are skipped; `module`/`package` set `modulePath` (first one wins); EOF inside a require block is an error at the opening line; stop at the first error and return no dependencies
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 4.10, 5.5_

  - [x] 3.2 Implement `src/core/requirePrinter.ts`
    - `printRequireBlock(deps)` returns `require (\n` + `\t<path> <version>\n` per dependency + `)\n`, with values unquoted
    - _Requirements: 4.7_

  - [x] 3.3 Create shared fast-check generators for the parser
    - In `test/unit/arbitraries.ts`, add: valid token (ASCII, non-ASCII, astral, plus tricky values `(`, `)`, `()`, `a//b`, `require`, `module`), valid dependency, layout (single-line requires and require blocks), a layout renderer that records line numbers, and noise transforms (comments, blank lines, whitespace, `// indirect`, quoting, non-require directives and blocks)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.8_

  - [x] 3.4 Write property test for parse order
    - File: `test/unit/properties/p01-parse-order.test.ts`
    - **Property 1: Parsing returns declared dependencies in file order**
    - **Validates: Requirements 4.1, 4.2, 4.9**

  - [x] 3.5 Write property test for noise invariance
    - File: `test/unit/properties/p02-parse-noise.test.ts`
    - **Property 2: Presentation noise does not change parse output**
    - **Validates: Requirements 4.3, 4.4, 4.5**

  - [x] 3.6 Write property test for malformed input
    - File: `test/unit/properties/p03-parse-errors.test.ts`; inject one defect (missing token, or an unclosed `require (`) and assert `error.line` equals the recorded line
    - **Property 3: Malformed input reports the defect's line and no dependencies**
    - **Validates: Requirements 4.6, 4.10**

  - [x] 3.7 Write property test for printer structure
    - File: `test/unit/properties/p04-printer-structure.test.ts`
    - **Property 4: Printer emits the required block structure**
    - **Validates: Requirements 4.7**

  - [x] 3.8 Write property test for the print/parse round trip
    - File: `test/unit/properties/p05-round-trip.test.ts`
    - **Property 5: Print then parse round trip**
    - **Validates: Requirements 4.8**

  - [x] 3.9 Write parser unit tests
    - File: `test/unit/goModParser.test.ts`: empty string; a realistic go.mod (module, go, toolchain, two require blocks, indirect markers, a replace block); pseudo-versions and `+incompatible` preserved verbatim; CRLF; leading BOM; unterminated quote error; three-token require error; `module` vs `package` first-wins
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 4.10_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the installed-tree model
  - [x] 5.1 Implement `src/core/installedModel.ts`
    - Export `FolderGoModState`, `InstalledSnapshot`, `InstalledNode`, and `buildInstalledTree(snapshot)`
    - Rules: zero folders → `NO_FOLDER` message; all absent → `NO_GO_MOD` message; one present file → its children at the top level; two or more → one group per file labeled `modulePath ?? folderName` (folder name for `readError`), sorted by `compareCodePoints` with folder URI as the tiebreaker
    - File children: stable-sorted package nodes (duplicates kept), `NO_PACKAGES` message, `parseError` error node, or `readError` error node
    - Stable ids: `group:<folderUri>`, `pkg:<folderUri>:<index>:<path>`, `msg:<folderUri|root>:<kind>`
    - _Requirements: 5.1, 5.4, 5.5, 5.7, 5.8, 5.9, 7.1, 7.2, 7.3, 7.4, 7.6, 7.7_

  - [x] 5.2 Implement `src/core/treeItemProps.ts`
    - Pure `toTreeItemProps(node)` that returns plain props: `label`, `description`, `tooltip`, `collapsibleState` (`'none' | 'expanded'`), and `iconId` (`package`, `folder`, `info`, `error`), following the mapping in the design
    - _Requirements: 5.2, 5.3, 5.5, 5.6_

  - [x] 5.3 Add snapshot generators to the shared arbitraries
    - Extend `test/unit/arbitraries.ts` with `FolderGoModState` and `InstalledSnapshot` generators: absent/parsed/parseError/readError states, unique folder URIs, optional module paths, and parse errors with and without line numbers
    - _Requirements: 5.1, 5.5, 7.1, 7.2_

  - [x] 5.4 Write property test for per-file children
    - File: `test/unit/properties/p08-file-children.test.ts`
    - **Property 8: Each go.mod file's children reflect its state**
    - **Validates: Requirements 5.1, 5.8, 5.9, 7.3, 7.4, 7.6**

  - [x] 5.5 Write property test for sorting
    - File: `test/unit/properties/p09-sorting.test.ts`
    - **Property 9: Package and group nodes are sorted by code point**
    - **Validates: Requirements 5.4**

  - [x] 5.6 Write property test for root structure
    - File: `test/unit/properties/p10-root-structure.test.ts`; check group expansion through `toTreeItemProps`
    - **Property 10: Root structure matches the number of go.mod files**
    - **Validates: Requirements 5.5, 5.7, 5.8, 7.1, 7.2**

  - [x] 5.7 Write property test for package tree items
    - File: `test/unit/properties/p11-package-tree-item.test.ts`
    - **Property 11: Package tree items show path, version, and tooltip exactly**
    - **Validates: Requirements 5.2, 5.3, 5.6**

  - [x] 5.8 Write property test for error isolation
    - File: `test/unit/properties/p12-error-isolation.test.ts`
    - **Property 12: Errors in one go.mod file do not affect other files**
    - **Validates: Requirements 5.9, 6.6, 7.7**

  - [x] 5.9 Write model unit tests
    - File: `test/unit/installedModel.test.ts`: zero folders; a mix of absent and present folders; a 500-dependency file builds well under 2 seconds
    - _Requirements: 5.1, 5.8, 7.1, 7.2_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the VS Code adapter for the Installed view
  - [x] 7.1 Implement `src/vscode/goModRepository.ts`
    - Constructor takes injectable dependencies: a `FileReader`, the output channel, a watcher factory, a workspace-folders source with its change event, and `debounceMs` (default 300)
    - `initialize()`: one entry per workspace folder, one `RelativePattern(folder, 'go.mod')` watcher per folder whose create/change/delete events call `debouncer.schedule(folderUri, load)`, and a subscription to `onDidChangeWorkspaceFolders` (removed folders drop their entry, watcher, and pending debounce; added folders load right away)
    - `load(folder)`: bump the generation, read and decode with `TextDecoder('utf-8')`, call `parseGoMod`, drop stale results or results for removed folders, map `FileNotFound` → `absent` and other errors → `readError` with the output line `[<ISO time>] Failed to read <fsPath>: <error>`, wrap in try/catch (log the stack), then fire `onDidChange`
    - `refreshAll()` cancels pending debounces and loads every folder in parallel; `snapshot()` returns folders in workspace order; `dispose()` cleans up
    - _Requirements: 5.1, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 7.5, 7.8_

  - [x] 7.2 Write repository unit tests with fakes
    - File: `test/unit/goModRepository.test.ts`, extending `test/unit/vscodeStub.ts` as needed: initial load; folder added and removed; `refreshAll` re-reads and cancels pending debounces; `FileNotFound` → `absent`; other read errors → `readError` plus an output channel line; recovery from error to parsed; a stale read discarded by the generation counter; a burst of watcher events produces one load
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 7.5, 7.8_

  - [x] 7.3 Implement `src/vscode/installedTreeProvider.ts`
    - `getChildren()` returns cached `buildInstalledTree(repo.snapshot())` at the root and `group.children` for groups; the cache is invalidated and `onDidChangeTreeData` fires on `repo.onDidChange`; `getChildren` never throws (it falls back to a single error node)
    - `getTreeItem()` maps `toTreeItemProps` to a `vscode.TreeItem` with `id`, `ThemeIcon`, and `TreeItemCollapsibleState`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 6.1, 6.6_

  - [x] 7.4 Write tree provider unit tests
    - File: `test/unit/installedTreeProvider.test.ts`: root and group children; refresh on repository change; the fallback error node when model building throws
    - _Requirements: 5.2, 5.3, 5.5, 5.6, 6.1_

- [x] 8. Implement the Search webview
  - [x] 8.1 Implement the webview script and stylesheet
    - `src/webview/search.ts`: on load, restore `input.value` from `getState()?.text`; on `input`, `setState({ text: clampSearchText(input.value) })`; on Enter `keydown`, call `preventDefault()` only; never call `postMessage`
    - `media/search.css`: a full-width input styled with `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-input-placeholderForeground`, `--vscode-focusBorder`, `--vscode-font-family`, and `--vscode-font-size`
    - Add a second entry point to `esbuild.mjs` that bundles `src/webview/search.ts` to `media/search.js` (IIFE, browser platform)
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 8.2 Implement `src/vscode/searchViewProvider.ts`
    - `resolveWebviewView` sets `enableScripts: true` and `localResourceRoots: [media]`, and renders HTML with a strict CSP (`default-src 'none'; style-src ${cspSource}; script-src 'nonce-<random>'`), links to `search.css`/`search.js`, and exactly one `<input id="search" type="text" maxlength="256" placeholder="Search Go packages" aria-label="Search Go packages" spellcheck="false" autocomplete="off">`
    - Expose the HTML builder as a pure exported function so it can be tested
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6_

  - [x] 8.3 Write Search view unit tests
    - File: `test/unit/searchView.test.ts`: the HTML has exactly one text input with the expected `aria-label`, `placeholder`, and `maxlength`, and a CSP with a nonce; `search.css` references the required theme variables; the webview script run against a fake `acquireVsCodeApi` and a minimal DOM restores state, saves clamped text on input, calls `preventDefault` on Enter, and never calls `postMessage`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 9. Wire the extension together
  - [x] 9.1 Implement `src/extension.ts`
    - `activate`: create the "Goget Manager" output channel, a `GoModRepository` wired to `vscode.workspace.fs`/watchers/folder events, an `InstalledTreeProvider` registered through `createTreeView('gogetManager.installed', { treeDataProvider, showCollapseAll: false })`, and a `SearchViewProvider` registered with `retainContextWhenHidden: true`; register `gogetManager.refresh` → `repository.refreshAll()`; push every disposable into `context.subscriptions`; call `repository.initialize()`
    - `deactivate`: no-op (disposables are cleaned up through subscriptions)
    - Confirm `npm run build` and `npm run typecheck` succeed
    - _Requirements: 1.5, 1.8, 3.7, 5.1, 6.1, 6.2, 6.3, 6.4, 7.5_

  - [x] 9.2 Write integration tests in the VS Code host
    - Create `.vscode-test.mjs`, fixture workspaces in `test/fixtures/` (single-folder, multi-root `.code-workspace`, no-go.mod), and Mocha tests in `test/integration/`
    - Cover: `workbench.view.extension.goget-manager` resolves both views; a flat sorted list for one folder; sorted, expanded groups for multi-root; writing, rapidly rewriting, and deleting `go.mod` updates the tree within 2 seconds; an unsaved editor edit leaves the tree unchanged; adding and removing a workspace folder; the refresh command re-reads from disk
    - _Requirements: 1.5, 1.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 6.1, 6.2, 6.4, 6.5, 6.7, 7.8_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Requirements 1.2–1.4, 1.7, 2.4, 2.6, and 2.7 come from built-in VS Code behavior that the manifest in task 1.1 enables. The design's manual verification checklist covers them
- Each property test maps to one correctness property in the design and runs at least 100 iterations
- Unit tests cover specific examples and edge cases that the properties don't express well

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.3", "2.5", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.6", "3.2", "3.3", "5.1"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "5.2", "7.1", "8.1", "8.2"] },
    { "id": 4, "tasks": ["5.3", "5.9", "7.2", "7.3", "8.3"] },
    { "id": 5, "tasks": ["5.4", "5.5", "5.6", "5.7", "5.8", "7.4", "9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
