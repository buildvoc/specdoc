# SpecDoc HedgeDoc 2 read-only board

A small compatibility board for the HedgeDoc 2 adapter in `../hd2-adapter`.
It is deliberately read-only: no approvals, GitHub publication, review bots,
checkpoints, or HedgeDoc editor mutations are performed.

Defaults:

- board listen: `0.0.0.0:8080`
- adapter source: `http://127.0.0.1:8081`
- only notes with HedgeDoc metadata `permissions.publiclyVisible === true`

Optional environment variables:

- `SPECDOC_BOARD_HOST`
- `SPECDOC_BOARD_PORT`
- `SPECDOC_BOARD_SOURCE`
- `SPECDOC_BOARD_PUBLIC_ONLY` (`true` by default)
- `SPECDOC_BOARD_TITLE`
- `SPECDOC_BOARD_CACHE_SECONDS`
- `SPECDOC_BOARD_FETCH_TIMEOUT_MS`

The adapter patch adds `publiclyVisible` to each `/api/specs` item and accepts
`?public=true` to return only publicly visible notes.

HedgeDoc 2 note creation is two calls: create the note, then set visibility with
`PUT /api/v2/notes/:alias/metadata/permissions/visibility` and body
`{"newPubliclyVisible":true}`. The visibility flag controls public discovery;
it does not itself grant anonymous read permission.
