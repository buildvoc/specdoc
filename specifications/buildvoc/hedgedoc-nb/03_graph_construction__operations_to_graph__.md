# Graph Construction (Operations to Graph)

Following the [CNL Parsing & Operations](01_cnl_parsing___operations_.md) stage, which produces a discrete sequence of instructions, the **Graph Construction** subsystem acts as the assembler. Its responsibility is to transform the `CnlOperation[]` array into a persistent, interconnected `CnlGraphData` object, resolving all references between nodes, morphs, edges, and attributes to ensure a topologically sound knowledge graph.

## System Architecture & Data Flow

The subsystem implements a deterministic, multi-pass transformation engine. It consumes the flat stream of operations and builds an internal map of nodes, which then serves as the anchor for all subsequent relational and attribute-based linkages.

```mermaid
graph TD
    A[CnlOperation[] Array] --> B[operationsToGraph]
    subherence "Transformation Engine (operations-to-graph.ts)"
        B --> P1[Pass 1: Node Initialization]
        P1 -->|Create CnlNode & Basic Morph| P2[Pass 2: Morph Augmentation]
        P2 -->|Append context to existing nodes| P3[Pass 3: Linkage & Metadata]
        P3 -->|Resolve Edges, Attributes, & Graph State| E[CnlGraphData Object]
    end
    subgraph "Internal State"
        P1 -.-> M[nodesMap: Map<string, CnlNode>]
        P2 -.-> M
        P3 -.-> M
    end
```

## Internal Implementation

The core logic is contained within `packages/nodebook-core/src/operations-to-graph.ts`. The engine utilizes a three-pass algorithm to resolve dependencies that may be defined out of order in the operation array.

### Pass 1: Node Creation and Anchor Generation
The engine iterates through all `addNode` operations. For every valid node, it:
1.  **Validates Identity**: Skips operations with empty or whitespace-only IDs.
2.  **Enforces Uniqueness**: If a `nodeId` already exists in the `nodesMap`, the subsequent operation is ignored to prevent state corruption.
3.  **Constructs Node Properties**: Extracts `base_name`, `adjective`, `quantifier`, and `role`. The display name is computed as `${adjective} ${base_name}` if an adjective is present.
4.  **Generates a Basic Morph**: Automatically invokes `createBasicMorph(nodeId)`. This ensures every node has a primary structural anchor (`nbh`) to which relations and attributes can be attached even in the absence of explicit morph definitions.

### Pass 2: Morph Augmentation
The engine processes `addMorph` operations. It locates the target `nodeId` within the `nodesMap` and appends the new `MorphData` to the node's `morphs` array. This allows a single node to represent multiple overlapping semantic contexts (e.g., different states or perspectives of the same entity).

### Pass 3: Linkage, Attributes, and Global State
The final pass processes all remaining operations that require resolved references:

*   **Relation Linkage (`addRelation`)**: Creates `CnlEdge` objects. The engine validates that both `source_id` and `target_id` exist; if either is empty/invalid, the edge is discarded to prevent dangling pointers. It attempts to link the edge to a specific `morphId` provided in the operation; otherwise, it defaults to the node's "basic" morph.
*   **Attribute Linkage (`addAttribute`)**: Creates `CnlAttribute` objects. It handles metadata such as `unit`, `modality`, `quantifier`, and `negation`. Like relations, attributes are linked to a specific morph or the basic morph. This pass also populates the `abbreviations` registry.
*   **Graph-level Directives**: Processes operations that affect the global graph state, including:
    *   `updateGraphDescription`: Sets the top-level text description.
    *   `setCurrency`: Establishes the default unit for financial/mass calculations.
    *   `addExpression`: Adds mathematical logic to the graph's computable layer.
    *   `addQuery`: Registers Wh-word queries for later retrieval by the inference engine.

## Data Structures

The output of this subsystem is a `CnlGraphData` object, which serves as the single source of truth for the application state:

| Property | Type | Description |
| :---/--|---|---|
| `nodes` | `CnlNode[]` | The collection of all identified entities and their morphs. |
| `edges` | `CnlEdge[]` | All established relationships between nodes or morphs. |
| `attributes` | `CnlAttribute[]` | Key-value properties attached to specific nodes/morphs. |
| `abbreviations` | `Record<string, ...>` | A mapping of shorthand strings to full names and node IDs. |
| `expressions` | `Array<{id, expression}>` | Mathematical or logical strings for evaluation. |
| `queries` | `CnlQuery[]` | Registered search patterns (e.g., "What is the mass?"). |

## Implementation Constraints

*   **Referential Integrity**: The engine explicitly skips `addRelation` operations where the source or target cannot be resolved to an existing node, preventing runtime errors in the renderer.
*   **Deterministic Identity**: Node IDs are treated as immutable once created in Pass 1.
*   **Complexity**: The transformation process is $O(O)$, where $O$ is the number of operations, ensuring efficient reconstruction even for large graphs.

## Current Behavior vs. Known Gaps

| Feature | Status | Implementation Detail |
| :--- | :--- | :--- |
| **Multi-pass Resolution** | Complete | Successfully resolves morphs before relations/attributes. |
| **Basic Morph Injection** | Complete | Every node is guaranteed a `basic` morph anchor. |
| **Dangling Edge Prevention** | Complete | Skips edges with invalid source/target IDs. |
| **Attribute Abbreviation** | Complete | Populates the `abbreviations` map during Pass 3. |
| **Error Reporting** | Minimal | Errors are collected in an array but lacks line-specific context. |
| **Morph-Specific Linkage** | Partial | Supports linking to specific morphs, but relies on "basic" fallback. |

## Related Specifications

*   [CNL Parsing & Operations](01_cnl_parsing___operations_.md)
*   [Text Analysis Pipeline (NLP)](02_text_analysis_pipeline__nlp__.md)
*   [Morphs & Polymorphism](04_morphs___polymorphism_.md)
*   [Mathematical Expression Evaluation](05_mathematical_expression_evaluation_.md)
*   [Schema & Type System](06_schema___type_system_.md)
*   [Inference Engine (Prolog & Transitive Closure)](07_inference_engine__prolog___transitive_closure__.md)
