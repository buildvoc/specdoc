# CNL Parsing & Graph Transformation

Following the [SpecDoc Specification Pipeline](02_specdoc_specification_pipeline_.md), which manages the publication of finalized specifications, the **CNL Parsing & Graph Transformation** subsystem serves as the core compiler engine. It is responsible for translating unstructured, human-readable Controlled Natural Language (CNL) text into a structured, machine-executable, and topologically sound knowledge graph (`CnlGraphData`).

The subsystem operates as a two-stage pipeline:
1.  **Parsing Stage**: An NLP-driven process that converts raw CNL text into an intermediate array of discrete instructions called `CnlOperation[]`.
2.  **Transformation Stage**: A deterministic, multi-pass assembly engine that processes the operation array to construct a persistent graph structure, resolving all relational and attribute-based dependencies.

## Architecture and Data Flow

The subsystem implements a unidirectional data pipeline where semantic meaning is progressively structured from text to graph.

```mermaid
flowchart TD
    A[Raw CNL Text] --> B[Parsing Engine: cnl-parser.ts]
    subgraph "Stage 1: Parsing (Text $\to$ Operations)"
        B --> B1[Block Separation: Mindmap vs CNL]
        B1 --> B2[Structural Tree Construction]
        B2 --> B3[Node & Morph Extraction]
        B3 --> B4[Neighborhood Scans: Attrs/Rels/Queries]
    end
    B4 --> C[CnlOperation[] Array]
    C --> D[Transformation Engine: operations-to-graph.ts]
    subgraph "Stage 2: Transformation (Operations $\to$ Graph)"
        D --> D1[Pass 1: Node Creation & Basic Morphs]
        D1 --> D2[Pass 2: Morph Augmentation]
        D2 --> D3[Pass 3: Edge/Attribute/Update Linkage]
    end
    D3 --> E[CnlGraphData Object]

    subgraph "Internal State"
        M1[nodesMap: Map<string, CnlNode>]
        M2[abbreviations: Record<string, ...>]
    end
    D1 -.-> M1
    D3 -.-> M2
```

### Interfaces and Dependencies
* **Input Interface**: Accepts raw string input representing CNL content (primarily from Markdown/HedgeDoc sources).
* **Output Interface**: Produces a `CnlGraphData` object, which serves as the primary state for downstream modules like [Memex Knowledge Graph Construction](04_memex_knowledge_graph_construction_.md).
* **Internal Dependencies**: 
    * **Regex Engine**: Utilizes complex regular expressions for pattern matching of attributes and relations.
    * **String Utilities**: Relies on `singularize` and `cnlNameToId` for deterministic ID generation.

### Implementation Constraints
* **Referential Integrity**: The transformation engine must explicitly discard `addRelation` or `addAttribute` operations if the target `nodeId` or `morphId` does not exist in the current state.
* **Complexity**: Parsing is $O(N)$ relative to text length, and transformation is $O(O)$ relative to the number of operations, ensuring linear scalability.
* **Deterministic Identity**: Node IDs are immutable once created in Pass 1; subsequent attempts to redefine an existing ID are ignored to prevent state corruption.

## Internal Implementation: The Parsing Engine

Implemented in `packages/nodebook-core/src/cnl-parser.ts`, the parsing engine performs structural analysis of the input text.

### 1. Block Separation and Tree Construction
The parser uses `parseAllBlocks` to partition input into two distinct semantic zones:
* **Mindmap Blocks**: Identified by `-` indentation, used for hierarchical structure.
* **CNL Blocks**: Identified by `#` headings, containing the primary node definitions.

### 2. Node Heading Processing
The `processNodeHeading` function extracts metadata from Markdown headers:
* **Quantifiers/Adjectives**: e.g., `*many* **red** Dogs`.
* **Roles/Types**: Extracted from brackets `[class]` or parentheses `(individual)`.
* **Implicit Relations**: Patterns like `# Dog [Animal]` automatically trigger an `addRelation` operation (`Dog <is_a> Animal`).

### 3. Neighborhood Scanning
The engine performs a localized scan of the text beneath each node to identify:
* **Attributes**: Lines containing `:` (e.g., `mass: 70;`), supporting negation (`!`) and units (`*kg*`).
* **Relations**: Lines wrapped in `<...>` (e.g., `<is_a> Animal;`), supporting weights.
* **Queries**: Specialized Wh-word patterns for graph traversal.

## Internal Implementation: The Transformation Engine

Implemented in `packages/nodebook-core/src/operations-to-graph.ts`, the engine utilizes a three-pass algorithm to resolve dependencies that may be defined out of order in the `CnlOperation[]` array.

### Pass 1: Node Initialization
The engine iterates through all `addNode` operations. For every valid operation:
1.  **Identity Validation**: Skips empty or whitespace IDs.
2.  **Uniqueness Enforcement**: If a `nodeId` exists in the `nodesMap`, the operation is ignored.
3.  **Basic Morph Injection**: Automatically calls `createBasicMorph(nodeId)`. This ensures every node has a primary structural anchor (`nbh`) to which relations can be attached even if no explicit morphs are defined.

### Pass 2: Morph Augmentation
The engine processes `addMorph` operations. It locates the existing `nodeId` within the `nodesMap` and appends new `MorphData` to the node's `morphs` array, allowing a single node to represent multiple semantic contexts or states.

### Pass 3: Linkage and Metadata
The final pass processes all operations requiring resolved references:
* **Relation Linkage (`addRelation`)**: Creates `CnlEdge` objects. The engine validates both `source_id` and `target_id`. If no `morphId` is provided, it defaults to the node's "basic" morph.
* **Attribute Linkage (`addAttribute`)**: Creates `CnlAttribute` objects, handling metadata such as units, modality, and negation. It also populates the `abbreviations` registry.
* **Global Directives**: Processes operations affecting the global graph state, such as `updateGraphDescription`, `setCurrency`, and `addExpression`.

### Identity Normalization
To ensure deterministic behavior, the subsystem implements:
```typescript
// Simplified logic for ID determinism
function cnlNameToId(name: string): string {
    return name.toLowerCase()
        .replace(/[^a-z0-9]/g, '') // Remove special characters
        .split(' ')
        .map(singularize)          // Apply heuristic singularization
        .join('');
}
```

## Current Behavior vs. Known Gaps

| Feature | Status | Implementation Detail |
| :--- | :--- | :--- |
| **Multi-pass Resolution** | Complete | Successfully resolves morphs before relations/attributes. |
| **Basic Morph Injection** | Complete | Every node is guaranteed a `basic` morph anchor. |
| **Dangling Edge Prevention** | Complete | Skips edges with invalid source/target IDs. |
| **Attribute Parsing** | Complete | Supports units, modalities, and negation (`!`). |
| **Error Reporting** | Minimal | Errors are collected in an array but lack line-specific context. |
| **Relation Aliasing** | Partial | Limited to a fixed set of predefined aliases (e.g., `debit`). |

## Future Requirements
* **Contextual Error Mapping**: Enhancing the parser to map syntax errors back to specific line numbers in the source CNL text.
* **Dynamic Schema Validation**: Integrating a schema/type system to validate that attribute values (e.g., mass) conform to expected units or ranges during the transformation stage.

## Related Specification Documents
* [PocketFlow LLM Orchestration](01_pocketflow_llm_orchestration_.md)
* [SpecDoc Specification Pipeline](02_specdoc_specification_pipeline_.md)
* [Memex Knowledge Graph Construction](04_memex_knowledge_graph_construction_.md)
