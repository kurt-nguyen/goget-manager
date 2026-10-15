# Requirements Document

## Introduction

Goget Manager is a VS Code extension written in TypeScript that helps developers view and (in future iterations) manage the Go package dependencies of the currently open project. The extension contributes its own icon to the VS Code Activity Bar, placed after the built-in Extensions icon. Selecting the icon opens a side bar container with a layout modeled on the VS Code Extensions view, containing two collapsible sections:

- **Search**: a search text box only. Search behavior is out of scope for this iteration.
- **Installed**: a list of every Go package installed to the current project by "go get" command, each entry showing the package path and version.

Out of scope for this iteration: executing searches, installing/upgrading/removing packages, interpreting `replace`/`exclude`/`retract` directives, and resolving the full transitive package graph.

## Glossary

- **Goget_Manager**: The VS Code extension described by this document.
- **Activity_Bar_Item**: The icon contributed by Goget_Manager to the VS Code Activity Bar, using `imgs/goget-manager-icon.png` as its image.
- **Goget_Container**: The side bar view container opened when the user selects the Activity_Bar_Item.
- **Search_View**: The section inside Goget_Container titled "Search".
- **Search_Box**: The single-line text input displayed in Search_View.
- **Installed_View**: The section inside Goget_Container titled "Installed".
- **Package_Item**: One entry in Installed_View representing a single Package_Dependency.
- **Workspace_Folder**: A root folder opened in the current VS Code window.
- **Go_Mod_File**: A file named `go.mod` located at the root of a Workspace_Folder.
- **Package_Dependency**: A pair of package path and version declared in a `require` directive of a Go_Mod_File (single-line or block form), including entries marked `// indirect`.
- **Go_Mod_Parser**: The Goget_Manager component that reads Go_Mod_File text and produces a list of Package_Dependency values.
- **Require_Printer**: The Goget_Manager component that formats a list of Package_Dependency values as a valid `go.mod` `require` block.

## Requirements

### Requirement 1: Activity Bar Entry

**User Story:** As a Go developer, I want a Goget Manager icon in the Activity Bar, so that I can open the package manager with one click, the same way I open the Extensions view.

#### Acceptance Criteria

1. WHILE the Goget_Manager extension is installed and enabled, THE Goget_Manager SHALL contribute exactly one Activity_Bar_Item to the VS Code Activity Bar, and the Activity_Bar_Item SHALL be visible whether or not a Workspace_Folder is open and whether or not a Go_Mod_File exists.
2. WHEN the user hovers the pointer over the Activity_Bar_Item, or moves keyboard focus to the Activity_Bar_Item, THE Activity_Bar_Item SHALL show the tooltip text "Goget Manager", using that exact spelling and capitalization.
3. THE Activity_Bar_Item SHALL use the image file `imgs/goget-manager-icon.png` that ships in the extension package as its icon. VS Code applies its standard Activity Bar sizing and theme-based tinting to that icon.
4. WHILE the Activity Bar is in its default layout, meaning the user has not dragged any items to reorder them, THE Activity_Bar_Item SHALL appear after (below) the built-in Extensions icon.
5. WHILE the Goget_Container is not visible in the primary side bar, WHEN the user selects the Activity_Bar_Item by mouse click or keyboard activation, THE Goget_Manager SHALL show the Goget_Container in the primary side bar within 1 second. The Goget_Container SHALL replace any other view container that was shown there.
6. THE Goget_Container SHALL show the title "GOGET MANAGER" in the primary side bar header. Text that matches case-insensitively passes, because VS Code may render view container titles in uppercase.
7. WHILE the Goget_Container is visible in the primary side bar, WHEN the user selects the Activity_Bar_Item, THE Goget_Manager SHALL hide the primary side bar. This matches how selecting the active Extensions icon behaves.
8. WHEN the Goget_Container opens, THE Goget_Container SHALL contain both the Search_View and the Installed_View.

### Requirement 2: Container Layout

**User Story:** As a Go developer, I want the Goget Manager side bar to be laid out like the Extensions view, so that the interface feels familiar.

#### Acceptance Criteria

1. THE Goget_Container SHALL display exactly two sections: the Search_View as the first (topmost) section and the Installed_View as the second section, directly below the Search_View. This order SHALL stay the same whether each section is collapsed or expanded.
2. THE Search_View SHALL display the section header text "SEARCH", matching exactly including case, at the top of the Search_View.
3. THE Installed_View SHALL display the section header text "INSTALLED", matching exactly including case, at the top of the Installed_View.
4. WHEN the user selects the header of the Search_View or the Installed_View, by mouse click or by pressing Enter or Space while the header has keyboard focus, THE Goget_Container SHALL switch only that section between the collapsed and expanded states within 200 milliseconds. The other section SHALL keep its current state.
5. WHEN the Goget_Container is opened for the first time in a workspace, THE Goget_Container SHALL display both the Search_View and the Installed_View in the expanded state.
6. WHILE a section is in the collapsed state, THE Goget_Container SHALL keep that section's header visible and hide all of that section's content. For the Search_View, the hidden content is the Search_Box. For the Installed_View, the hidden content is all Package_Item entries and message items.
7. WHEN the Goget_Container is reopened in a workspace where the Goget_Container was opened before, including after a window reload or a VS Code restart, THE Goget_Container SHALL show each of the Search_View and the Installed_View in the collapsed or expanded state that section had when the Goget_Container was last closed in that workspace.

### Requirement 3: Search Section

**User Story:** As a Go developer, I want a search box in the Search section, so that the layout is ready for package search in a future release.

#### Acceptance Criteria

1. THE Search_View SHALL display exactly one Search_Box as a single-line text input positioned at the top of the Search_View, which is reachable by keyboard Tab navigation and exposes the accessible name "Search Go packages" to screen readers.
2. WHILE the Search_Box contains zero characters, THE Search_Box SHALL display the placeholder text "Search Go packages", and WHILE the Search_Box contains one or more characters, THE Search_Box SHALL hide the placeholder text.
3. WHEN the user types, pastes, or deletes characters in the Search_Box, THE Search_Box SHALL display the resulting text, with a maximum length of 256 characters, within 100 milliseconds of the input.
4. THE Search_Box SHALL use the active VS Code color theme for its foreground, background, border, and focus colors, and WHEN the user switches the active VS Code color theme, THE Search_Box SHALL apply the new theme colors without requiring a window reload or reopening the Search_View.
5. WHEN the user changes the Search_Box text or presses Enter in the Search_Box, THE Goget_Manager SHALL perform no search, SHALL leave the Package_Items displayed in the Installed_View unchanged, and SHALL display no error message or notification.
6. IF the user types or pastes text that would make the Search_Box content exceed 256 characters, THEN THE Search_Box SHALL keep the first 256 characters, discard the excess characters, and display no error message.
7. WHEN the Search_View is collapsed and re-expanded, or the Goget_Container is hidden and shown again, within the same VS Code window session, THE Search_Box SHALL display the same text the Search_Box contained before being collapsed or hidden.

### Requirement 4: Parse Go Package Dependencies

**User Story:** As a Go developer, I want the extension to read my project's `go.mod`, so that the Installed section reflects the packages my project actually requires.

#### Acceptance Criteria

1. WHEN a Go_Mod_File is provided, THE Go_Mod_Parser SHALL return one Package_Dependency for each `require <package path> <version>` single-line directive in the Go_Mod_File. The Package_Dependency values SHALL appear in the same order as their entries appear in the file.
2. WHEN a Go_Mod_File is provided, THE Go_Mod_Parser SHALL return one Package_Dependency for each non-blank, non-comment line between a `require (` line and its matching `)` line. This SHALL apply to any number of blocks, including blocks mixed with single-line `require` directives, and all Package_Dependency values SHALL appear in file order.
3. WHEN a `require` entry carries the `// indirect` comment, THE Go_Mod_Parser SHALL include that entry as a Package_Dependency at its file-order position. The Package_Dependency SHALL have the same package path and version the entry would produce without the comment.
4. WHEN a Go_Mod_File contains full-line `//` comments, trailing `//` comments after a version, blank lines, leading or trailing spaces and tabs, or directives other than `require` (including `package`, `go`, `toolchain`, `replace`, `exclude`, and `retract`), THE Go_Mod_Parser SHALL leave that content out of the returned Package_Dependency values.
5. WHEN a package path or version in a Go_Mod_File is written as a double-quoted or back-quoted string, THE Go_Mod_Parser SHALL return the value without its enclosing quote characters.
6. IF a `require` entry in a Go_Mod_File is missing a package path or a version, THEN THE Go_Mod_Parser SHALL return an error identifying the 1-based line number of the malformed entry and SHALL return no Package_Dependency values.
7. WHEN a list of Package_Dependency values is provided, THE Require_Printer SHALL produce a `go.mod` `require` block with this structure:
   - a `require (` opening line
   - one tab-indented `<package path> <version>` line per Package_Dependency, in the order of the input list, with path and version unquoted
   - a `)` closing line

   For an empty list, the block SHALL contain only the opening and closing lines.
8. FOR ALL lists of valid Package_Dependency values, printing with the Require_Printer and then parsing with the Go_Mod_Parser SHALL produce a list equal to the original list (round-trip property).
   - A Package_Dependency is valid when its package path and version are each non-empty, contain no whitespace or quote characters, and do not begin with `//`.
   - Two lists are equal when they have the same length and the same package path and version at each position.
9. WHEN a Go_Mod_File that contains no `require` entries is provided, including an empty file, THE Go_Mod_Parser SHALL return an empty list of Package_Dependency values and no error.
10. IF a `require (` block in a Go_Mod_File has no matching `)` line before the end of the file, THEN THE Go_Mod_Parser SHALL return an error identifying the 1-based line number of the unclosed `require (` line and SHALL return no Package_Dependency values.

### Requirement 5: Installed Packages List

**User Story:** As a Go developer, I want to see every package installed in my project with its version, so that I know what my project depends on at a glance.

#### Acceptance Criteria

1. WHEN the Installed_View becomes visible, THE Installed_View SHALL display, within 2 seconds for Go_Mod_Files containing a combined total of up to 500 Package_Dependencies, exactly one Package_Item for each Package_Dependency returned by the Go_Mod_Parser for each Go_Mod_File in the open Workspace_Folders, with no Package_Dependency omitted and none duplicated within the same Go_Mod_File.
2. THE Package_Item SHALL display the full package path of the Package_Dependency, exactly as declared in the Go_Mod_File, as the primary label.
3. THE Package_Item SHALL display the version of the Package_Dependency, exactly as declared in the Go_Mod_File (including any pre-release, build, or pseudo-version suffix and without modification), as secondary text on the same row immediately after the primary label.
4. THE Installed_View SHALL order Package_Items within each list or group in ascending lexicographic order of the package path, compared character by character by Unicode code point, and SHALL order Go_Mod_File group nodes by the same rule applied to their labels.
5. IF more than one open Workspace_Folder contains a Go_Mod_File, THEN THE Installed_View SHALL group Package_Items under one collapsible node per Go_Mod_File, labeled with the `package` path declared in that Go_Mod_File (or with the Workspace_Folder name when the Go_Mod_File declares no `package` path), with every group node expanded when the Installed_View first becomes visible.
6. WHEN the user hovers over a Package_Item, THE Package_Item SHALL display a tooltip containing the package path and version of the Package_Dependency, identical to the values shown in the primary label and secondary text.
7. IF exactly one open Workspace_Folder contains a Go_Mod_File, THEN THE Installed_View SHALL display the Package_Items of that Go_Mod_File as a flat list with no group node.
8. IF the open Workspace_Folders contain no Go_Mod_File, or every Go_Mod_File contains zero Package_Dependencies, THEN THE Installed_View SHALL display zero Package_Items and the applicable message defined in Requirement 7 (criterion 1, 2, or 3).
9. IF the Go_Mod_Parser returns an error for a Go_Mod_File, THEN THE Installed_View SHALL display the error message defined in Requirement 7 criterion 4 in place of the Package_Items of that Go_Mod_File, and SHALL display the Package_Items of every other Go_Mod_File as defined in Requirement 7 criterion 7.

### Requirement 6: Keep the Installed List Current

**User Story:** As a Go developer, I want the Installed list to update when my `go.mod` changes, so that I always see the current dependencies.

#### Acceptance Criteria

1. WHEN the contents of a Go_Mod_File change on disk, whether through an editor save, creation of the file, or modification by an external process such as the go command, THE Installed_View SHALL display Package_Items matching the Package_Dependencies in that Go_Mod_File's saved contents within 2 seconds of the change, and SHALL ignore unsaved editor changes to the Go_Mod_File.
2. WHEN a Workspace_Folder is added to or removed from the current window, THE Installed_View SHALL display Package_Items matching only the Go_Mod_Files of the Workspace_Folders open after the change within 2 seconds of the change, with no Package_Items remaining from a removed Workspace_Folder.
3. THE Installed_View SHALL display a "Refresh" action in the Installed_View header whenever the Installed_View is visible, with the tooltip "Refresh".
4. WHEN the user selects the "Refresh" action, THE Installed_View SHALL re-read the Go_Mod_File of every open Workspace_Folder from disk and display Package_Items matching those Go_Mod_Files' current contents within 2 seconds of the selection.
5. WHEN a Go_Mod_File is deleted, THE Installed_View SHALL remove every Package_Item from that Go_Mod_File's Workspace_Folder within 2 seconds of the deletion and leave the Package_Items of other Workspace_Folders unchanged.
6. IF, during an update or refresh, a Go_Mod_File cannot be read from disk or the Go_Mod_Parser returns an error for a Go_Mod_File, THEN THE Installed_View SHALL replace the Package_Items previously shown for that Go_Mod_File with the error message defined in Requirement 7 (criterion 6 for read errors, criterion 4 for parse errors), and SHALL leave the Package_Items of other Go_Mod_Files unchanged as defined in Requirement 7 criterion 7.
7. WHEN a Go_Mod_File changes more than once within 2 seconds, THE Installed_View SHALL display exactly one Package_Item per Package_Dependency in the Go_Mod_File's contents after the last change, within 2 seconds of that last change.

### Requirement 7: Empty and Error States

**User Story:** As a Go developer, I want clear messages when there is nothing to show or something goes wrong, so that I understand why the Installed list is empty.

#### Acceptance Criteria

1. IF no Workspace_Folder is open, THEN THE Installed_View SHALL display exactly one message item with the text "Open a folder containing a go.mod file to see installed packages." and SHALL display zero Package_Items.
2. IF one or more Workspace_Folders are open AND none of the open Workspace_Folders contains a Go_Mod_File at its root, THEN THE Installed_View SHALL display exactly one message item with the text "No go.mod file found in the current workspace." and SHALL display zero Package_Items.
3. IF a Go_Mod_File is parsed successfully by the Go_Mod_Parser AND contains zero Package_Dependency entries, THEN THE Installed_View SHALL display the message "No packages installed." in place of that Go_Mod_File's Package_Items, shown at the top level of the Installed_View when exactly one Go_Mod_File is present and inside that Go_Mod_File's group when two or more Go_Mod_Files are present.
4. IF the Go_Mod_Parser returns an error for a Go_Mod_File, THEN THE Installed_View SHALL display, in place of that Go_Mod_File's Package_Items (inside its group when two or more Go_Mod_Files are present), an error message containing the Go_Mod_File path and the line number reported by the Go_Mod_Parser, omitting the line number only when the Go_Mod_Parser reports none, and SHALL display zero Package_Items for that Go_Mod_File.
5. IF a Go_Mod_File cannot be read from disk, THEN THE Goget_Manager SHALL write the file path and the read error to the Goget_Manager output channel.
6. IF a Go_Mod_File cannot be read from disk, THEN THE Installed_View SHALL display, in place of that Go_Mod_File's Package_Items (inside its group when two or more Go_Mod_Files are present), an error message indicating that the file could not be read and containing the Go_Mod_File path.
7. IF a parse error or read error occurs for one Go_Mod_File while two or more Go_Mod_Files are present, THEN THE Installed_View SHALL continue to display the Package_Items or messages of every other Go_Mod_File unchanged.
8. WHEN the condition that caused a message in criteria 1 through 4 or 6 stops applying (a Workspace_Folder is opened, a Go_Mod_File is created, a Package_Dependency is added, or a parse or read error is fixed and saved to disk), THE Installed_View SHALL remove that message and display the resulting Package_Items within 2 seconds.
