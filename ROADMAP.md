# SpecDoc Roadmap

## In Progress

- Reliable HedgeDoc Publishing
- GitHub Issue Workflow

## Planned

- Human Review Preservation
- Multi-Project Specifications
- HedgeDoc Discovery & Linking
- Refresh Health & Recovery

## Feature Areas

### Reliable HedgeDoc Publishing
Stable identities, publication manifests, transactional updates, recovery, and superseded-note retirement.

### Human Review Preservation
Protect reviewer-authored content and lifecycle state during generated refreshes.

### Multi-Project Specifications
Allow multiple source repositories to maintain independent specification sets.

### HedgeDoc Discovery & Linking
Discover relevant public specs and maintain valid cross-spec links.

### Refresh Health & Recovery
Expose generation/publication status, failures, authentication health, and recovery state.

### GitHub Issue Workflow
Create, display, label, and track GitHub Issues directly from SpecBoard.

<!-- specdoc-board-repository-roadmap -->
## Implemented — Board repository management

Implemented 2026-10-03:

- [x] Add GitHub repositories from the Board.
- [x] Validate repository remotes before cloning.
- [x] Reuse existing local checkouts by Git origin.
- [x] Handle case differences in local repository paths.
- [x] Avoid same-name repository path collisions.
- [x] Discover all Git repositories below `/data/projects`.
- [x] Provide `GET /api/repositories`.
- [x] Persist Board repository metadata.
- [x] Provide Board **Repositories** and **+ Repository** controls.
<!-- /specdoc-board-repository-roadmap -->
