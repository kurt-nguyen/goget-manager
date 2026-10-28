# Changelog

All notable changes to the Goget Manager extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-10-28

### Added

- Goget Manager view container in the Activity Bar with **Search** and **Installed** views.
- Search for Go packages on pkg.go.dev, with debounced search-as-you-type and Enter to search immediately. Results show the import path, name, synopsis, latest version, publish date and import count.
- **Installed** badge on search results that are already required by a workspace `go.mod`.
- Installed view listing the `require` entries of each workspace folder's `go.mod`, with versions, grouped by module when several folders have a `go.mod`, and refreshed automatically when `go.mod` changes.
- `Goget Manager: Refresh` command, also available as a button in the Installed view title bar.
- Package detail tab, reused for every selection, showing metadata, package checks, links, README and documentation, with a GOOS dropdown when pkg.go.dev offers one.
- Install and Uninstall from the detail tab, using `go get` and `go mod edit -droprequire`, with a folder picker when several `go.mod` files apply.
- **Goget Manager** output channel with timestamped logs of searches, page loads and Go commands.
