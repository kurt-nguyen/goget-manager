# Install/Uninstall from the package Detail tab

The Detail tab's Install/Uninstall button now does real work. Install runs `go get -- <path>` and Uninstall runs `go mod edit -droprequire=<module>` in a workspace folder. After each run the host calls `repository.refreshAll()`, and the Detail button, the Installed view and the Search "Installed" badge all re-derive from go.mod. No parallel installed flag exists. Busy and failure states travel on a new lightweight `action` message so the button is never rebuilt and keeps keyboard focus. Every requirement in the request maps to code and to a test.

Watch for: (1) an uninstall that exits 0 but leaves the package still required (another workspace folder requires it) returns the button to "Uninstall" with no explanation, unlike install which reports `INSTALL_NOT_RECORDED` (likely, non-blocking). (2) The Go child is killed on timeout with `execFile`'s kill, which on Windows may not take down grandchildren such as `git` (possible, non-blocking). (3) Real VS Code behaviour (QuickPick, webview focus, watcher timing, live network `go get`) is only covered by unit tests and the plan's manual checklist; integration tests were not run.

**Verdict**: APPROVED

## High-level view

The design routes everything through go.mod. A Go command changes the file, `refreshAll()` reloads it, and `onDidChange` already drives the Installed tree, the Search `installed` message and `DetailController.refreshInstalled()`. That removes the sync problem by construction, and it makes "command succeeded but nothing changed" detectable instead of hidden.

`PackageActions` is a pure, serialised service. It refuses stdlib and flag-like paths before running Go, resolves a sub-package to its module for uninstall, asks for a folder only when several qualify, and reloads go.mod after any Go run that returned, success or failure. `createGoRunner` uses `execFile` with an argument array, no shell, `GOWORK=off`, a 180 s timeout and a 64 KiB output cap.

`DetailController` keeps a per-path pending map, ignores requests that are busy, contradict the current flag, or arrive in a non-ready state, and re-reads the flag from go.mod when the action settles. Failure leaves state as go.mod has it, shows the reason inline, and writes full output to the output channel. The webview ignores clicks while busy and uses `aria-disabled` rather than `disabled`.

<details>
<summary>Issues (3)</summary>

1. **Silent uninstall no-op** — in `finishAction`, a successful uninstall that leaves `installed` true (multi-root, another folder still requires the module) clears the busy state with no message. Emit a notice mirroring `INSTALL_NOT_RECORDED`, or name the remaining folder. Non-blocking.
2. **Timeout kill on Windows** — the `execFile` timeout kills only `go`; child processes such as `git` may keep running after the UI reports the timeout. Consider a process-tree kill if this shows up in practice. Non-blocking.
3. **No end-to-end run in VS Code** — QuickPick, webview focus retention on `aria-disabled`, high-contrast theming and real-network `go get` were not exercised. Run the plan's manual F5 checklist before release. Non-blocking.

</details>

<details>
<summary>Details</summary>

## Requirement trace

All four install and four uninstall bullets are met (confirmed in `detailController.ts`, `packageActions.ts`, `extension.ts`). `installUninstallSync.test.ts` composes the real repository, tree provider, Search provider, controller and `PackageActions` to pin both directions.

## Where the state lives

`computeInstalled` is the only writer of the installed flag after an action. `refreshInstalled()` firing mid-action emits an `installed` message that the webview applies with the current `busy`, so the busy label survives. Switching packages and back re-applies `busy` through the `setState` overlay of `pending`.

```
click -> runAction -> pending.set, emit action{busy}
      -> PackageActions (queue) -> go -> refreshAll -> onDidChange
                                                   -> Installed tree / Search installed / refreshInstalled
      -> finishAction -> computeInstalled -> emit action{installed, error?}
```

## Uninstall that does not change installed state

`finishAction` only checks for the unrecorded case on install. If uninstall exits 0 but the path still resolves as installed, for example a second workspace folder requires the same module or a different `require` still covers the sub-package, the button returns to "Uninstall" with no error and the Search badge stays. The user picked a folder, so the outcome is defensible, but nothing says why the package is still there (likely). The fix is small: report a message when `kind === 'uninstall' && result.ok && installed`.

## Go runner and timeout

Any signalled exit maps to `timeout`, and `execFile`'s timeout kills the direct child only. On Windows `go get` may have `git` children that survive (possible; check by timing out a slow `go get` and looking for orphaned `git.exe`).

## Test coverage

Covered: the install/uninstall happy path and failure across all views, stdlib and `-flag` refusal, multi-folder picker including cancel, serialisation with a failing first call, error mapping for each Go failure reason, busy survival across GOOS change and package switching, dispose/reset mid-action, webview busy/error rendering with hostile text kept as text, malformed `action` messages ignored, and a Search view resolved only after the install. The commit message and the plan's verification note agree: typecheck exit 0, build exit 0 with `aria-disabled` in `media/detail.js`, 661 passed / 7 skipped / 1 failed, with the failure being the known `searchSmoke` "contains no hard-coded colors" (`media/search.css`, not touched by this diff), and the live Go runner test passed 2/2. I did not re-run any suite.

Not tested: real VS Code QuickPick, webview focus behaviour, theming, and the uninstall-still-installed case described above.

</details>

<details>
<summary>File map</summary>

- `src/core/packageActions.ts` — new serialised install/uninstall service
- `src/vscode/goRunner.ts` — new `execFile` Go runner
- `src/core/detailController.ts` — stub replaced with pending map, busy and error handling
- `src/core/detailProtocol.ts` — `busy`, `actionError`, `action` message
- `src/core/installedMatch.ts` — `findInstalledModule`, `isInstallablePath`
- `src/core/messages.ts` — action strings and log helpers
- `src/core/detailHtml.ts` — `#detail-action-error` region
- `src/extension.ts` — wires runner, actions and QuickPick folder picker
- `src/webview/detail.ts`, `src/webview/detailRender.ts` — busy button, error region, click guard
- `media/detail.css` — disabled and error styles
- `test/unit/*` — new and updated tests for all of the above

Full diff: `git diff main`

</details>
