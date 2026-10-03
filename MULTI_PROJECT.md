# Multi-Project Specifications

Milestone 3 makes each source checkout a separate SpecDoc project.

Project identity is resolved from the checkout's `origin` Git remote. For `/data/projects/hedgedoc-nb-frontend` with `origin=https://github.com/buildvoc/hedgedoc-nb.git`, SpecDoc uses:

- namespace: `buildvoc/hedgedoc-nb`
- output: `specifications/buildvoc/hedgedoc-nb/`
- HedgeDoc aliases: `buildvoc-hedgedoc-nb-*`
- project manifest: `specifications/buildvoc/hedgedoc-nb/manifest.json`
- registry entry: `projects/registry.json`

`buildvoc/specdoc` keeps its existing `specdoc-*` aliases for compatibility.

Refreshing one source path no longer replaces another project's generated specification directory or aliases.

<!-- specdoc-board-repository-discovery -->
## Repository discovery

Multi-project repository discovery is based on Git repositories immediately below:

`/data/projects`

The Board discovers folders containing `.git`, reads each repository's `origin`, and where possible identifies it as `owner/repo`.

Adding a repository through **+ Repository** does not create a special one-project configuration. The repository becomes part of the same discovery set used by **Repositories**.

Existing repositories are matched by Git remote rather than directory-name case alone. This allows an existing checkout such as `/data/projects/pic2bim` to be reused for `https://github.com/buildvoc/PIC2BIM`.

Repository registry:

`/data/projects/specdoc/hd2-board/data/repositories.json`
<!-- /specdoc-board-repository-discovery -->
