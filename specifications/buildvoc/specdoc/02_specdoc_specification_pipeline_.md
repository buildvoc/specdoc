# SpecDoc Specification Pipeline

While [PocketFlow LLM Orchestration](01_pocketflow_llm_orchestration_.md) handles the intelligent generation of technical content, the **SpecDoc Specification Pipeline** is responsible for transforming these raw, locally-generated Markdown files into a structured, published, and navigable corpus within HedgeDoc 2. It manages the lifecycle of a specification from its creation as a file to its publication as a networked resource accessible via SpecBoard.

## Purpose and Responsibility

The pipeline implements an automated publishing workflow that ensures technical specifications are not just generated, but also integrated into the broader documentation ecosystem. Its primary responsibilities include:

1.  **Link Transformation**: Rewriting local Markdown cross-references to point to valid HedgeDoc 2 URLs using generated aliases.
2.  **Metadata Enrichment**: Injecting structured YAML frontmatter (e.g., `namespace`, `source-path`, `github-repo`) into specifications to enable advanced filtering and traceability.
3.  **HedgeDoc 2 Synchronization**: Executing `POST` and `PUT` operations against the HedgeDoc 2 API to create or update notes.
4.  **Review Comment Preservation**: Implementing a mechanism to scrape existing human-written review comments from HedgeDoc 2 and re-inject them into the newly published automated content, preventing the loss of human feedback during automated updates.
5.  **API Abstraction**: Providing an adapter layer (`hd2-adapter`) that exposes HedgeDoc 2 specifications through a standardized REST API for consumption by SpecBoard.

## Architecture and Data Flow

The pipeline operates as a unidirectional flow from source code to the user interface.

```mermaid
flowchart TD
    subgraph "Generation Phase"
        A[Source Repository] --> B[PocketFlow Nodes]
        B --> C[Local Markdown Files\n/specdoc/specifications/]
    end

    subframe "Publishing Pipeline (publish_specs.py)"
        C --> D[Link Rewriting & Slug Generation]
        D --> E[Frontmatter Injection]
        E --> F[HedgeDoc 2 API Sync]
    end

    subgraph "Presentation Phase"
        F --> G[(HedgeDoc 2 Database)]
        H[hd2-adapter] -->|Proxies/Transforms| G
        I[SpecBoard UI] -->|Requests Specs| H
    end
```

### Interfaces and Dependencies

*   **Internal Interface**: The pipeline relies on the file structure produced by the `WriteChapters` BatchNode in [PocketFlow LLM Orchestration](01_pocketflow_llm_orchestration_.md).
*   **External Dependencies**:
    *   **HedgeDoc 2 API**: The primary target for publication, requiring a valid `HD2_TOKEN`.
    *   **Environment Configuration**: Uses `.env` files to manage `HD_BASE_URL`, `SPECDOC_NAMESPACE`, and `SPECDOC_ALIAS_PREFIX`.
    *   **Git**: Used by the publishing script to extract branch and commit information for metadata enrichment.

## Internal Implementation Details

### The Publishing Engine (`multi_project/publish_specs.py`)

The core of the pipeline is a Python-based execution engine that iterates through the `SPECDOC_SPEC_DIR`.

#### 1. Link Rewriting
The engine uses regular expressions to identify local Markdown links and map them to HedgeDoc URLs. It calculates an `alias` for every file using a slugification process.

```python
# Example of link transformation logic in publish_specs.py
link_re = re.compile(r'\]\(([^)\s]+\.md)(#[^)]+)?\)')

def repl(m):
    target = aliases.get(Path(m.group(1)).name)
    return f"]({base}/n/{target}{m.group(2) or '')})" if target else m.group(0)

body = link_re.sub(repl, body)
```

#### 2. Metadata Injection and Frontmatter Construction
For every file, the script constructs a new YAML frontmatter block. This block contains critical routing information used by the `hd2-adapter` to organize notes into namespaces.

Key fields injected:
*   `namespace`: The HedgeDoc path (e.g., `local/specs`).
*   `source-path`: The local filesystem path of the origin file.
*   `alias`: The unique identifier for the note in HedgeHD 2.
*   `generated`: A boolean flag indicating the content is automated.

#### 3. Review Comment Preservation
To solve the problem of "overwriting" human interaction, the pipeline implements `preserve_review_comments`. It parses the existing content on HedgeDoc 2 for a specific pattern (`{>> ... <<}`) and ensures those strings are appended to the new version being published.

### The Adapter Service (`hd2-adapter/server.js`)

The adapter acts as a specialized middleware between SpecBoard and HedgeDoc 2. It provides a simplified API specifically for "Specification" objects, filtering out non-spec notes from the HedgeDoc instance.

#### Key API Endpoints:
*   `GET /api/specs`: Returns a filtered list of all notes tagged with `spec`. It supports query parameters for `ns` (namespace) and `status` (e.g., `draft`, `approved`).
*   `GET /api/specs/:id`: Retrieves the full content, including parsed frontmatter and extracted critic counts (review comments).
*   `POST /api/specs/:id/update`: Allows SpecBoard to perform granular text replacements within a specification without overwriting the entire document.

#### Implementation Constraint: Content Size
The adapter enforces strict limits on incoming payloads for `update` and `replace` operations (e.g., 20,000 characters for updates) to prevent memory exhaustion and ensure stability of the Node.js event loop.

## Current Behavior

*   **Automated Batch Publishing**: The pipeline can process an entire directory of specifications in a single execution.
*   **Namespace Management**: Supports organizing specifications into different HedgeDoc namespaces based on `aliasPrefix` configuration.
*   **Atomic Manifest Generation**: After publication, the pipeline generates a `manifest.json` containing the version, commit hash, and a list of all published files/URLs, which serves as the source of truth for the SpecBoard.

## Known Gaps

*   **Lack of Incremental Publishing**: The current script iterates through all files in the directory; it does not natively track which files have changed since the last run, potentially causing unnecessary API load on HedgeDoc 2.
*   **Manual Triggering**: Publication is triggered via shell scripts (`publish-specs.sh`) or manual execution, rather than being event-driven by repository changes.

## Future Requirements

*   **Webhook Integration**: Implementing a listener that triggers the pipeline automatically upon `git push` events to the source repository.
*   **Dependency Tracking**: Enhancing the manifest to include the relationship graph between specifications, derived from the link transformation logic.

## Related Specification Documents

- [PocketFlow LLM Orchestration](01_pocketflow_llm_orchestration_.md)
- [CNL Parsing & Graph Transformation](03_cnl_parsing___graph_transformation_.md)
- [Memex Knowledge Graph Construction](04_memex_knowledge_graph_construction_.md)
