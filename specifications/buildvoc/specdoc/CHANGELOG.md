# Change Log

## [2026-09-21 - 2026-10-03]

### Added

#### spec-board
- Simplified cards and change notices.
- Automated flagging of conflicts with neighboring specifications during review.
- Ability to set a specification's milestone directly from its board card.
- Support for initiating planning from an empty state and performing deliberate deletions.
- Implementation of board change reporting to replace full page reloads.
- Functionality to commit filters by shape and guards against unsaved edits.
- Naming of gates on every amendment row.
- Unified sign-in control and auto-closing menus.
- Integration of the board view into the address bar.
- Addition of member lists to milestones and implementation of survivable saves.

#### mcp
- Support for HedgeDoc stable IDs in MCP tracing.
- Capability to reach named specifications outside the current scope and date the corpus.

### Fixed

#### spec-board
- Improved inline handling of sign-in and search implementers.
- Inclusion of necessary shell scripts within the container image.
- Resolved redundant printing of digest fact links.
- Corrected planning save reporting to reflect written content accurately.
- Ensured board view persistence in the address bar across submissions.

### Documentation
- Added documentation for Board repository management.
- Detailed the conflict checking process during review.
- Documented procedures for reading the board and mapping pages to the codebase.
