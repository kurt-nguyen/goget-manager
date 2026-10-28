# Goget Manager

Search pkg.go.dev, see what your `go.mod` requires, and install or remove Go packages without leaving VS Code.

Goget Manager adds a **Goget Manager** view container to the Activity Bar with two views: **Search** and **Installed**. Package details open in an editor tab with the package's README and documentation.

## Features

- **Search Go packages.** Type in the Search view to query [pkg.go.dev](https://pkg.go.dev). Results update as you type after a short pause, or immediately when you press Enter. Each result shows the import path, package name, a short synopsis, the latest version, the publish date and the number of imports.
- **Installed badge.** Search results that are already required by a `go.mod` in your workspace are marked **Installed**. Packages inside an installed module are matched too.
- **Installed view.** Lists the modules required by the `go.mod` in each workspace folder, sorted by path, with their versions. The list updates when `go.mod` changes on disk, and a Refresh button reloads it on demand. When more than one workspace folder has a `go.mod`, the packages are grouped by module.
- **Package detail tab.** Click a search result or an installed package to open a single, reusable tab in the editor area. It shows:
  - title, import path, version, publish date, licenses, import counts and repository links
  - pkg.go.dev's package checks (for example valid `go.mod`, redistributable license, stable version)
  - the package README (long READMEs start collapsed with an Expand button)
  - the package documentation, with a **Rendered for** dropdown to switch the GOOS build context when the page offers one
  - a link to open the page on pkg.go.dev
- **Install and uninstall.** Use the button in the detail tab to run `go get` for a package, or to remove it from `go.mod`. Output of each run is written to the **Goget Manager** output channel.

## Requirements

- VS Code 1.85.0 or later.
- The [Go toolchain](https://go.dev/dl/) available on your `PATH`. It is only needed for installing and uninstalling.
- An internet connection to reach pkg.go.dev for searching and for loading package details.
- A workspace folder with a `go.mod` file in its root. Without one, the Installed view shows a hint and Install reports that no `go.mod` was found.

## Usage

1. Open a folder that contains a `go.mod` file.
2. Click the **Goget Manager** icon in the Activity Bar.
3. **Search:** type in the Search view's box (up to 256 characters). Press Enter to search right away.
4. **View details:** click a search result or a package in the Installed view. The detail tab opens in the editor area. Clicking another package reuses the same tab.
5. **Install:** in the detail tab, click **Install**. If several workspace folders have a `go.mod`, you are asked which one to use. The extension runs `go get` in that folder.
6. **Uninstall:** in the detail tab of an installed package, click **Uninstall**. The extension runs `go mod edit -droprequire=<module>` in the folder of the chosen `go.mod`. If more than one `go.mod` requires the package, you are asked which one to use.
7. **Refresh:** click the refresh icon in the title bar of the Installed view to reload `go.mod` files.

Standard library packages (for example `os`) can be viewed but not installed.

## Commands

| Command | ID | Description |
| --- | --- | --- |
| Goget Manager: Refresh | `gogetManager.refresh` | Reloads the `go.mod` files shown in the Installed view. Also available as a button in that view's title bar. |

## Extension Settings

This extension does not contribute any settings.

## Known Issues and Limitations

- Only the `go.mod` in the root of each workspace folder is read. Nested modules in subfolders are not detected.
- The Installed view lists every `require` entry in `go.mod`, including indirect ones. It does not read `replace` or `exclude` directives.
- Uninstall removes the `require` entry from `go.mod` only. It does not run `go mod tidy` and does not delete anything from the module cache.
- Go commands run with `GOWORK=off`, so they act on the selected folder's `go.mod` and not on a `go.work` workspace. A command is stopped after 3 minutes.
- Search and package details depend on the HTML of pkg.go.dev. If the site changes its layout, some details may be missing or a page may fail to load.
- The detail tab shows the README and documentation only. Source files, directory listings, version history and import lists are not shown, and code examples inside the documentation are not rendered. Use **View on pkg.go.dev** for those.
- The detail tab is not restored after reloading the window.
- Searching and loading package details need a network connection. Results are not cached.

## Privacy and Network Use

- The extension requests pages from `https://pkg.go.dev` (search results and package pages). Requests are sent from the extension host with the user agent `goget-manager-vscode`, honor your VS Code proxy settings, and only follow redirects that stay on pkg.go.dev.
- Your search text and the import paths of the packages you open are sent to pkg.go.dev as part of those requests.
- Package READMEs can embed remote images. The detail tab loads those images over HTTPS, lazily and without a referrer.
- Links inside package pages open in your default browser.
- `go get` talks to the Go module proxy and source hosts according to your Go configuration (`GOPROXY` and related settings).
- The extension collects no telemetry and sends no other data.

## Contributing and Issues

Bug reports and suggestions are welcome. Please open an issue at `<REPOSITORY_URL>/issues` and include your VS Code version, your Go version and the relevant lines from the **Goget Manager** output channel (View > Output).

## License

[MIT](LICENSE.md)
