# SpecDoc HedgeDoc 2 adapter

Small local-only adapter for evaluating SpecDoc MCP against HedgeDoc 2 without GitHub.

Defaults:

- reads `/data/projects/hedgedoc/.env`
- uses `HD_BASE_URL` (or `HD2_URL`) and `HD2_TOKEN`
- listens on `127.0.0.1:8081`
- exposes `GET /statusz`, `GET /api/specs`, and `GET /api/specs/:id`
- discovers notes owned by the bearer-token user and includes notes tagged `spec`
- uses namespace `local/specs` unless `SPECDOC_HD2_NAMESPACE` is set

Point the existing SpecDoc MCP server at it with:

`SPECDOC_URL=http://127.0.0.1:8081`
