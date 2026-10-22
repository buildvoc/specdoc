# SpecDoc

SpecDoc generates technical specifications from source repositories using PocketFlow, publishes them to HedgeDoc 2, and presents them through SpecBoard.

## Architecture

Source repository
→ PocketFlow
→ Generated specifications
→ HedgeDoc 2
→ SpecDoc adapter
→ SpecBoard

## Components

- `pocketflow/` — specification generation
- `/data/projects/specdoc-authoring/specifications/` — generated specification corpus (outside the application repository)
- `hd2-adapter/` — HedgeDoc 2 compatibility API
- `hd2-board/` — SpecBoard web application
- `publish-specs.sh` — publishes specifications to HedgeDoc
- `refresh-specdoc.sh` — command-line refresh workflow
- `refresh-specdoc-board.sh` — board-triggered refresh workflow
- `ROADMAP.md` — feature roadmap

## Runtime

- HedgeDoc 2: `http://192.168.1.142:8180`
- SpecBoard: `http://192.168.1.142:8080`
- Adapter: `http://127.0.0.1:8081`

## Refresh

Run:

`/data/projects/specdoc/refresh-specdoc.sh`

SpecBoard can also trigger a refresh for a selected source path.

Generated specifications default to:

`/data/projects/specdoc-authoring/specifications/<owner>/<repo>/`

Override the root with `SPECDOC_SPEC_ROOT`. HedgeDoc publication still uses
`SPECDOC_SPEC_DIR`, so existing aliases are updated in place rather than creating
a second set of notes.

## GitHub Issues

Repository:

`https://github.com/buildvoc/specdoc`

## MCP

The previous MCP implementation is retired and is not part of the active runtime.

<!-- specdoc-board-repositories -->
## Board repository management

The SpecDoc Board supports repository management directly from the Board UI.

- **+ Repository** accepts a GitHub repository URL in the form `https://github.com/owner/repo`.
- G3 validates the remote before cloning.
- Existing checkouts under `/data/projects` are detected by their Git `origin` and reused.
- New repositories are normally cloned to `/data/projects/<repo>`.
- If that path is already occupied by a different repository, the fallback path is `/data/projects/<owner>-<repo>`.
- **Repositories** shows all immediate Git repositories discovered under `/data/projects`.
- Repository metadata is synchronized to `/data/projects/specdoc/hd2-board/data/repositories.json`.

Board API:

- `POST /api/repo-add`
- `GET /api/repositories`

The Board service is `specdoc-hd2-board.service`.
<!-- /specdoc-board-repositories -->
