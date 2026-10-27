# Installed badge on Search view results

Search results whose package path is an installed module, or a package inside one, now show a text "Installed" badge. Matching is a pure function in `src/core/installedMatch.ts` that ignores go.mod versions and treats `/vN` (N >= 2) as a different module. The installed set reaches the webview through a new `installed` host message. It is driven by `repository.onDidChange`, the same event the Installed tree uses, so go.mod edits, workspace-folder changes and manual refresh all update the badge without a new search. The webview matches at render time, so new search results are covered by the same path.

Watch for: (1) the `.result-badge` border uses `var(--vscode-contrastBorder)` without the `transparent` fallback the plan specified (possible, cosmetic only); (2) live refresh, high-contrast appearance and screen reader output were not verified in a running VS Code, as the coder noted.

**Verdict**: APPROVED

## High-level view

The matching rule is exact path or prefix at a `/` boundary, with a `/vN` segment after the installed module path vetoing that prefix. This is the documented sub-package behavior and the tests pin it, including `yy`, `v2`, `v10`, `vendor`, `v1` and `gopkg.in` cases.

Installed state travels in a separate `installed` message. The `state` message shape is untouched, and `SearchViewProvider` takes an optional source, so existing provider tests are unaffected. `extension.ts` feeds it from `collectInstalledModulePaths(repository.snapshot())`, so there is no second go.mod parse. On `ready` the provider posts `installed` before `state`, and the subscription is stored in `viewSubscriptions`, so it is disposed with the view.

The badge is a `<span class="result-badge installed-badge">Installed</span>` placed first inside `.result-desc`. It is announced through `aria-describedby`, which matters because the button's `aria-label` hides its other content. The label is text, and the colors are VS Code badge variables with a contrast border for high-contrast themes. A list rebuild is triggered by a changed installed-index set, so status and loading updates still do not rebuild. Focus on a result button is restored by `data-index` after an installed-driven rebuild.

`media/search.js` is gitignored and untracked (plan correction to the brief). The local bundle contains `installed-badge` and its mtime (11:52:22) is later than `render.ts` and `search.ts` (11:52:09 and 11:50:18), so it matches the sources. The coder recorded typecheck OK, 42 files / 426 tests passing, and build OK in the commit message. I did not re-run any suite.

<details>
<summary>Issues (2)</summary>

1. **Border fallback dropped (possible, non-blocking)** — `.result-badge` has `border: 1px solid var(--vscode-contrastBorder)` where the plan had `var(--vscode-contrastBorder, transparent)`. If the variable is unset in non-high-contrast themes, the declaration is invalid at computed-value time and the border is omitted, which is harmless. Add the `transparent` fallback for parity with the plan if desired.
2. **Runtime behavior unverified (non-blocking)** — Live go.mod refresh, multi-root, theme/high-contrast rendering and screen reader announcement were not exercised in an Extension Development Host. Do a manual F5 check before release.

</details>

<details>
<summary>Details</summary>

### Matching rule and its placement in core

`isInstalledPackage` checks the exact path first, then walks prefixes from longest to shortest. A prefix hit counts unless the next path segment is a major-version suffix. A longer installed prefix such as `M/v2` is reached before `M`, so `M/v2/sub` matches when `M/v2` is installed and not when only `M` is. The loop terminates correctly: `end > 0` guards the `lastIndexOf(.., end - 1)` call. `collectInstalledModulePaths` only reads `parsed` folders from the existing `InstalledSnapshot`, dedupes across roots, and sorts by code point. The module has no `vscode` import, which is consistent with the rest of `src/core`. Confirmed by reading the code and the 12 unit cases in `test/unit/installedMatch.test.ts`, which cover the plan's listed matrix.

### Live update path

```
GoModRepository.onDidChange --> SearchViewProvider.postInstalled --> webview 'installed'
                                       (modules() = collect(snapshot()))        |
                                                                   Set<string> + lastState --> renderState
```

An `installed` message that arrives before any `state` only stores the set. The next `state` message renders with it. The webview validates the message shape (`isInstalledMessage`) before use. The first `ready` can precede repository initialization, but the later `onDidChange` re-posts the set, so that race is covered. The provider tests cover ordering on `ready`, a post on change, and no listener accumulation across dispose and re-resolve. The render tests cover rebuild on flag change and no rebuild when an unrelated module changes or only status changes.

### Badge markup and CSS

Placing the badge inside `.result-desc` is the right choice for accessibility, given the button's `aria-label`. `.result-desc` is `display: block` and the badge is `inline-block`, so it sits on its own line above the synopsis. The existing result classes use `--vscode-*` variables, and the new rules follow that. The only deviation from the plan is the missing `transparent` fallback noted in Issues.

### Scope

The diff contains the core module, protocol type, provider option, extension wiring, render/webview changes, CSS, tests and a short design.md note. There are no unrelated refactors. `isStateMessage` was narrowed to the `state` variant, which is required by the widened union.

</details>

<details>
<summary>File map</summary>

- `src/core/installedMatch.ts`: new pure matching and collection
- `src/core/searchProtocol.ts`: `installed` variant added to `HostToWebview`
- `src/vscode/searchViewProvider.ts`: optional `InstalledModulesSource`, posts on ready and on change
- `src/extension.ts`: passes repository event and module collector
- `src/webview/render.ts`: badge in description, rebuild keyed on installed flags
- `src/webview/search.ts`: `installed` message handling with focus restore
- `media/search.css`: badge styles
- `.kiro/specs/search-packages/design.md`: protocol, matching rule and markup notes
- `test/unit/installedMatch.test.ts`, `render.test.ts`, `searchView.test.ts`, `searchViewProvider.test.ts`: new coverage

Full diff: `git show HEAD`

</details>
