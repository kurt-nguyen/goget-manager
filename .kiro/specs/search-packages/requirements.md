# Requirements Document

## Introduction

This feature turns the existing Search_Box in Goget Manager into a working Go package search. The user types a query, and Goget_Manager looks up matching Go packages on pkg.go.dev and lists them in the Search_View, directly below the Search_Box.

### What already exists (not repeated here)

The `goget-manager-extension` spec and its implementation already provide:

- The Search_View webview with a single Search_Box (placeholder, accessible name, 256-character limit, theme colors, text persistence across collapse and hide).
- The Installed_View, `go.mod` parsing, and the Output channel named "Goget Manager".
- A pure `core` layer, a keyed debouncer, and a webview script that currently posts no messages to the extension host.

### Relationship to the existing spec

The existing spec declared search behavior out of scope and required the Search_Box to perform no search (Requirement 3, criterion 5, and the "Out of scope" paragraph of its Introduction). This feature replaces that one behavior. Every other criterion of the existing Requirement 3 stays in force. The existing requirement for the Installed_View to remain unchanged while the user interacts with the Search_Box is kept and restated in Requirement 7 below.

### Assumptions

The request "search packages" is short, so these assumptions were made. Please confirm or correct them.

1. **Data source**: Search results come from pkg.go.dev, the public Go package index. pkg.go.dev has no documented public search API, so Goget_Manager requests the same HTML search results page a browser uses and extracts the results from that page. This makes the extraction sensitive to markup changes on pkg.go.dev. The repository's `sample-pages/SearchResults.html` is a saved copy of that page and is the reference for field names.
2. **Search mode**: Only package search is supported (pkg.go.dev's "package" search mode). Symbol search is not supported.
3. **Trigger**: Searching starts automatically after the user pauses typing, and starts immediately when the user presses Enter.
4. **Result page**: Only the first page of results that pkg.go.dev returns is shown. Paging, "Load more", and sorting or filtering controls are not included.
5. **Result actions**: Activating a result opens its pkg.go.dev page in the default browser. Installing a package (running `go get`, editing `go.mod`) is a separate future feature.
6. **Network**: The extension host makes the HTTP request. The webview is not given network access.
7. **No printer for the results parser**: The Results_Parser reads third-party HTML that Goget_Manager never produces, so there is no matching printer and no parse/print round trip for it. The round-trip requirement applies to the query URL instead (Requirement 2).

### Out of scope

- Installing, upgrading, or removing packages from a search result.
- Symbol search, search history, saved searches, and search filters.
- Marking results that are already listed in the Installed_View.
- Paging beyond the first results page.
- Caching of results across VS Code restarts.
- A user setting to turn network search off or to choose a different package index.

## Glossary

- **Goget_Manager**: The VS Code extension described by this document.
- **Goget_Container**: The Goget Manager container that holds the Search_View and the Installed_View (defined in the existing spec).
- **Search_View**: The webview section titled "Search" in the Goget_Container (defined in the existing spec).
- **Search_Box**: The single-line text input in the Search_View (defined in the existing spec).
- **Installed_View**: The tree section titled "Installed" in the Goget_Container (defined in the existing spec).
- **Package_Item**: One entry displayed in the Installed_View (defined in the existing spec).
- **Output_Channel**: The VS Code output channel named "Goget Manager".
- **Search_Query**: The text of the Search_Box with leading and trailing whitespace removed.
- **Package_Index**: The pkg.go.dev web site.
- **Search_Client**: The Goget_Manager component that sends a Search_Query to the Package_Index and returns the HTML response.
- **Query_URL_Builder**: The Goget_Manager component that turns a Search_Query into the Package_Index search request URL.
- **Results_Parser**: The Goget_Manager component that converts a Package_Index search results HTML page into a list of Package_Result values.
- **Package_Result**: One search hit, made of a package path (required), a package name (required), a synopsis (optional), a latest version (optional), a published date (optional), and an imported-by count (optional).
- **Result_List**: The list of Package_Result entries shown in the Search_View below the Search_Box.
- **Status_Message**: A single line of text shown in the Search_View below the Search_Box, used for loading, empty, and error states.
- **Loading_Indicator**: A visible in-progress indicator shown in the Search_View while a search request is in flight.
- **In_Flight_Search**: A search request that has been sent and has not yet produced a response, an error, a timeout, or a cancellation.
- **Debounce_Delay**: 400 milliseconds.
- **Request_Timeout**: 10 seconds.

## Requirements

### Requirement 1: Start a Search

**User Story:** As a Go developer, I want my typing in the Search_Box to search for packages, so that I can find a package without leaving VS Code.

#### Acceptance Criteria

1. WHEN the user presses Enter in the Search_Box AND the Search_Query is non-empty, THE Search_View SHALL start a search for the Search_Query without waiting for the Debounce_Delay, even if the Search_Query equals the Search_Query of the most recently started search, and SHALL cancel any pending debounced search so that exactly one search is started for that Enter press.
2. WHEN the Search_Query becomes empty (including when the Search_Box text is empty or contains only whitespace), THE Search_View SHALL cancel any pending debounced search, cancel any In_Flight_Search, remove all entries from the Result_List, and clear the Status_Message.
3. WHEN a search starts while an In_Flight_Search exists, THE Goget_Manager SHALL cancel the In_Flight_Search and SHALL ignore any response, error, or Request_Timeout of 10 s that occurs for the cancelled search, so that the Result_List and Status_Message reflect only the newest search.
4. WHEN a search starts, THE Search_Client SHALL send exactly one request containing the Search_Query to the Package_Index, and the search SHALL remain an In_Flight_Search until a response is received, a failure occurs, the search is cancelled, or the Request_Timeout of 10 s elapses.
5. WHILE the Search_Query is empty, THE Goget_Manager SHALL send no request to the Package_Index, including when the Search_View is first opened.
6. IF the user presses Enter in the Search_Box AND the Search_Query is empty, THEN THE Search_View SHALL start no search, send no request to the Package_Index, and leave the Result_List and Status_Message unchanged.

### Requirement 2: Build the Search Request URL

**User Story:** As a Go developer, I want any text I type to be searched exactly as I typed it, so that queries with special characters return the right packages.

#### Acceptance Criteria

1. WHEN a non-empty Search_Query is provided, THE Query_URL_Builder SHALL produce an HTTPS URL on the host `pkg.go.dev` with the path `/search`, a `q` parameter holding the percent-encoded Search_Query, an `m` parameter with the value `package`, and no other query parameters.
2. THE Query_URL_Builder SHALL leave only the unreserved URL characters unencoded (`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`) and SHALL percent-encode every other character of the Search_Query, including spaces, `&`, `=`, `#`, `+`, `%`, `/`, and non-ASCII characters, as follows: each non-ASCII character is encoded as its UTF-8 bytes, each byte is written as `%` followed by two uppercase hexadecimal digits, a space is written as `%20` (never `+`), and a literal `+` is written as `%2B`.
3. FOR ALL Search_Query strings of 1 to 256 characters, percent-decoding the `q` parameter of the URL produced by the Query_URL_Builder (treating `%XX` sequences as UTF-8 bytes) SHALL yield a string identical to the original Search_Query (round-trip property).
4. FOR ALL Search_Query strings of 1 to 256 characters, THE URL produced by the Query_URL_Builder SHALL contain exactly one `q` parameter and exactly one `m` parameter, so that characters in the Search_Query cannot add or change other parameters.
5. IF the Search_Query is an empty string, THEN THE Query_URL_Builder SHALL produce no URL and SHALL return an indication that the Search_Query is empty.

### Requirement 3: Parse Search Results

**User Story:** As a Go developer, I want the search results to be read accurately from the Package_Index, so that the packages I see match what pkg.go.dev shows.

#### Acceptance Criteria

1. WHEN a Package_Index search results HTML page of up to 5 MB is provided, THE Results_Parser SHALL return, within 1 second, one Package_Result for each search result entry on the page, in the same order as the entries appear on the page, and SHALL keep entries that repeat the same package path. A search result entry is one block of the page that presents a single package with a title and an import path.
2. THE Results_Parser SHALL read the package path of each Package_Result from the full import path shown for the entry, without any surrounding parentheses and with leading and trailing whitespace removed, for example `go.mongodb.org/mongo-driver/v2/mongo` when the page shows `(go.mongodb.org/mongo-driver/v2/mongo)`.
3. THE Results_Parser SHALL read the package name of each Package_Result from the short name shown as the entry title, excluding the import path text and with leading and trailing whitespace removed, for example `mongo`.
4. WHEN a search result entry shows a synopsis, a latest version, a published date, or an imported-by count, THE Results_Parser SHALL include that value in the Package_Result as the visible text of the value only, without any label text such as "Imported by" or "published on" and without markup tags, after decoding HTML character references, collapsing runs of whitespace into single spaces, and removing leading and trailing whitespace. The imported-by count SHALL be kept as displayed text including any thousands separators (for example `1,289`), and the published date SHALL be kept as displayed text (for example `Oct 6, 2026` or `today`).
5. IF a search result entry does not show a synopsis, a latest version, a published date, or an imported-by count, or shows it with no text remaining after the processing in criterion 4, THEN THE Results_Parser SHALL leave that field absent from the Package_Result and SHALL keep the other fields of that entry.
6. IF a search result entry has no package path, a package path that is empty after whitespace removal, a package path that contains whitespace, or no package name, THEN THE Results_Parser SHALL leave that entry out of the returned list and SHALL keep the remaining entries in their original order.
7. WHEN an HTML page containing no search result entries is provided, including an empty string, THE Results_Parser SHALL return an empty list and no error.
8. IF the provided text contains an unterminated tag or other malformed HTML, THEN THE Results_Parser SHALL return the Package_Result values it could read from the entries whose package path and package name can both be read, SHALL leave out every other entry, and SHALL throw no exception.
9. FOR ALL Package_Result values returned by the Results_Parser, THE package path SHALL be non-empty and SHALL contain no whitespace characters.

### Requirement 4: Show Search Results

**User Story:** As a Go developer, I want to see each matching package with enough detail, so that I can pick the right one.

#### Acceptance Criteria

1. WHEN a search response containing one or more Package_Result values is received, THE Search_View SHALL, within 500 milliseconds of receiving the response, replace the previous Result_List with exactly one entry per Package_Result, in the same order as returned by the Results_Parser.
2. THE Search_View SHALL show for each Result_List entry the package path as the first and most prominent text of the entry, and the package name as a separate heading or label within that entry.
3. IF a Package_Result includes a synopsis, a latest version, a published date, or an imported-by count, THEN THE Search_View SHALL show each included value in that Result_List entry, with a synopsis longer than 300 characters truncated to 300 characters followed by an ellipsis.
4. THE Search_View SHALL render every Package_Result value as plain text, so that HTML, script, or markup characters in a value are shown literally and are never interpreted.
5. WHEN a search response containing one or more Package_Result values is received, THE Search_View SHALL, within 500 milliseconds of receiving the response, set the Status_Message to "<N> results", where N is the number of Package_Result values shown as a decimal integer, or to "1 result" when N is 1.
6. WHEN the user types in the Search_Box while a Result_List is displayed, THE Search_View SHALL keep the displayed Result_List and Status_Message unchanged until the next search response is received, the search is cancelled, or the Search_Query becomes empty.
7. WHEN a search response containing one or more Package_Result values is received, THE Search_View SHALL remove the Loading_Indicator within 500 milliseconds of receiving the response.
8. IF a Package_Result lacks a synopsis, a latest version, a published date, or an imported-by count, THEN THE Search_View SHALL omit that value from the Result_List entry and SHALL show no placeholder text, empty label, or zero value in its place.

### Requirement 5: Open a Package Page

**User Story:** As a Go developer, I want to open a result's documentation page, so that I can read about the package before using it.

#### Acceptance Criteria

1. WHEN the user activates a Result_List entry by mouse click, or by pressing Enter or Space while the entry has keyboard focus, THE Goget_Manager SHALL issue exactly one request to open the URL `https://pkg.go.dev/<package path>` of that entry in the default web browser within 1000 ms of the activation, where `<package path>` is the entry's package path exactly as displayed in the Result_List, and SHALL leave the Search_View query text and Result_List contents unchanged.
2. THE Search_View SHALL make every Result_List entry reachable by keyboard Tab navigation in the same top-to-bottom order as displayed, and SHALL display a focus indicator on the focused entry that is visually distinguishable from unfocused entries.
3. THE Search_View SHALL expose every Result_List entry to screen readers with an accessible name equal to the entry's package path, exactly as displayed.
4. IF the package path of an activated entry is empty, or the URL built for it is not an HTTPS URL on the host `pkg.go.dev`, THEN THE Goget_Manager SHALL leave the URL unopened, SHALL write one Output_Channel entry containing the package path and a reason indicating the URL is invalid or not an HTTPS `pkg.go.dev` URL, and SHALL leave the Result_List unchanged.
5. IF the request to open a valid URL in the default web browser fails, THEN THE Goget_Manager SHALL show an error notification indicating that the package page could not be opened, SHALL write one Output_Channel entry containing the package path and the failure reason, and SHALL leave the Result_List unchanged.

### Requirement 6: Loading, Empty, and Error States

**User Story:** As a Go developer, I want clear feedback while a search runs and when it fails, so that I know what is happening.

#### Acceptance Criteria

1. WHEN a search starts, THE Search_View SHALL show the Loading_Indicator and set the Status_Message to "Searching…" within 100 milliseconds, and SHALL keep the previously displayed Result_List unchanged until the search succeeds, returns zero results, or fails.
2. WHEN a search returns zero Package_Result values, THE Search_View SHALL remove all entries from the Result_List, remove the Loading_Indicator, and set the Status_Message to `No packages found for "<Search_Query>".`, where `<Search_Query>` is the submitted query text without modification.
3. IF the Search_Client cannot establish a connection to the Package_Index or the connection is lost before a complete HTTP response is received (for example DNS resolution failure, connection refused, or connection reset), THEN THE Search_View SHALL remove all entries from the Result_List, remove the Loading_Indicator, and set the Status_Message to "Could not reach pkg.go.dev. Check your internet connection and try again."
4. IF the Package_Index responds with an HTTP status code outside the range 200 to 299, THEN THE Search_View SHALL remove all entries from the Result_List, remove the Loading_Indicator, and set the Status_Message to "pkg.go.dev returned an error (HTTP <status code>). Try again later.", where `<status code>` is the numeric status code received.
5. IF the Request_Timeout of 10 seconds, measured from the start of the search, elapses before the Package_Index response is fully received, THEN THE Goget_Manager SHALL cancel the In_Flight_Search, and THE Search_View SHALL remove all entries from the Result_List, remove the Loading_Indicator, and set the Status_Message to "The search timed out. Try again."
6. IF a search fails for any reason described in criteria 3 to 5, THEN THE Goget_Manager SHALL write exactly one line to the Output_Channel containing an ISO 8601 timestamp, the Search_Query, and the failure reason, where the failure reason identifies the failure as unreachable, HTTP error (including the status code), or timeout.
7. IF a search fails, THEN THE Goget_Manager SHALL show no notification popup and no modal dialog.
8. WHILE the Search_View is showing a failure Status_Message from criteria 3 to 5 and the Search_Query is non-empty, WHEN the user presses Enter in the Search_Box, THE Search_View SHALL start a new search for the Search_Query.
9. IF an In_Flight_Search has been cancelled or superseded by a newer search, THEN THE Search_View SHALL ignore any response, error, or timeout from that earlier search and SHALL leave the Result_List, Loading_Indicator, and Status_Message unchanged by it.

### Requirement 7: Integration with the Existing Views

**User Story:** As a Go developer, I want search to fit into the existing Goget Manager view, so that it looks and behaves like the rest of VS Code.

#### Acceptance Criteria

1. WHEN a search starts, finishes, fails, or is cancelled, THE Installed_View SHALL keep the same Package_Item entries, with the same count and order, that it displayed before the event.
2. WHEN the Search_View is collapsed and re-expanded, or the Goget_Container is hidden and shown again, within the same VS Code window session, THE Search_View SHALL show the Search_Box text, Result_List entries (same count and order), Status_Message text, and Loading_Indicator visibility that reflect the latest search state, including the outcome of any search that finished while the Search_View was collapsed or hidden.
3. WHEN the user switches the active VS Code color theme, THE Search_View SHALL apply the new theme colors to the Result_List, Status_Message, and Loading_Indicator within 1 second, without a window reload and without clearing the Result_List, Status_Message, or Search_Box text.
4. WHEN the Status_Message changes to non-empty text, THE Search_View SHALL announce the new text to screen readers through a polite live region exactly once per change.
5. WHILE the Search_View is collapsed or hidden and a search is in flight, THE Goget_Manager SHALL let the search run to completion, failure, or cancellation, and SHALL retain its outcome (Result_List entries or failure Status_Message) until a new search starts or the Search_Box is cleared.
6. WHILE the Search_Box text is empty, WHEN the Search_View is shown for the first time in a window session (including after a window reload), THE Search_View SHALL show an empty Result_List, an empty Status_Message, and no Loading_Indicator.

### Requirement 8: Privacy and Network Use

**User Story:** As a Go developer, I want to know exactly what the extension sends over the network, so that I can trust it with my private projects.

#### Acceptance Criteria

1. THE Search_Client SHALL include only the Search_Query and the fixed parameters defined in Requirement 2 in the URL, headers, and body of each request it sends to the Package_Index, and SHALL exclude workspace folder names, file paths, `go.mod` contents, the list of installed packages, cookies, and authentication credentials.
2. THE Search_Client SHALL send each request, including each redirect it follows, only to the host `pkg.go.dev` over HTTPS.
3. IF the Package_Index responds with a redirect to a host other than `pkg.go.dev` or to a non-HTTPS URL, THEN THE Search_Client SHALL stop the request without sending any request to the redirect target, THE Search_View SHALL remove all entries from the Result_List, remove the Loading_Indicator, and set the Status_Message to "pkg.go.dev returned an error (HTTP <status code>). Try again later.", where `<status code>` is the HTTP status code of the redirect response.
4. IF the Package_Index responds with a redirect to a host other than `pkg.go.dev` or to a non-HTTPS URL, THEN THE Goget_Manager SHALL write one line to the Output_Channel containing an ISO 8601 timestamp, the Search_Query, and the redirect target host.
5. WHEN a search starts, THE Search_Client SHALL send the request only after any In_Flight_Search of the same Search_View has been cancelled, so that no more than 1 request per Search_View is in flight at any time.
6. THE Goget_Manager SHALL send no network request other than the Search_Client requests to the Package_Index, including no telemetry, analytics, or update-check requests.
7. THE Search_View SHALL pass only the Search_Query from the webview to the extension host, and THE extension host SHALL pass only Package_Result values and Status_Message text back to the webview.
