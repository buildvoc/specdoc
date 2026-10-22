# Inference Engine (Prolog & Transitive Closure)

While [Schema & Type System](06_schema___type_system_.md) defines the structural constraints and valid relationship types, the **Inference Engine** is responsible for executing the logic required to derive unstated knowledge from those definitions. It identifies "hidden" edges and attributes that are logically implied by the existing graph topology, such as transitive relationships, symmetric properties, and hierarchical inheritance.

The subsystem provides two distinct implementation paths: a synchronous, high-performance **Transitive Closure Engine** for standard graph traversals (BFS), and an asynchronous **Prolog Inference Engine** utilizing `tau-prolog` for complex logic and user-defined queries.

## System Architecture & Data Flow

The inference engine acts as a secondary processing layer that consumes the `CnlGraphData` and `MergedSchemas` to produce `InferredEdge[]` and `QueryResult[]`.

```mermaid
graph TD
    A[CnlGraphData] --> B{Engine Selection}
    S[MergedSchemas] --> B
    
    subgraph "Path 1: TransitiveClosureEngine (Sync)"
        B --> C[BFS Traversal]
        C --> C1[Transitive Relation Discovery]
        C --> C2[Membership/Instance Inheritance]
        C1 --> D[InferredEdge[]]
        C2 --> D
    end

    subgraph "Path 2: PrologInferenceEngine (Async)"
        B --> E[prolog-bridge.ts]
        E --> E1[Program Generation]
        E1 --> E2[Tau Prolog Session]
        E2 --> E3[Query Execution]
        E3 --> F[QueryResult[] & InferredEdge[]]
    end

    subgraph "Attribute Layer"
        A --> G[inheritance.ts]
        G --> H[InheritedAttribute[]]
    end
```

## Internal Implementation

The subsystem is divided into a local traversal engine, a logic-programming bridge, and an attribute inheritance module.

### 1. Transitive Closure Engine (`inference-engine.ts`)

Implemented via the `TransitiveClosureEngine` class, this engine uses a Breadth-First Search (BFS) algorithm to compute closures for relations marked as `transitive` in the schema.

*   **Transitive Discovery**: The engine builds an adjacency index (`adjByRelation`) specifically for transitive relations. It performs a BFS starting from every source node to find all reachable nodes, creating new `In\.inferred_` edges.
*   **Membership/Instance Inheritance**: This engine implements specific logic for the `member_of` and `instance_of` relations. If a node $X$ is a member of $A$, and $A$ is an instance of $B$ (via `is_a`), the engine infers $X$ is also a member of $B$.
*   **Cycle Prevention**: To prevent infinite loops in cyclic graphs (e.g., $A \to B \to C \to A$), the engine maintains a `visited` Set during each BFS traversal and skips self-loops.
*   **Deterministic Identity**: Inferred edges are assigned IDs using `fnv1aHash` on the edge key (`source|target|relation`) to ensure that the same logical inference always produces the same ID across engine reloads.

### 2. Prolog Inference Engine (`prolog-bridge.ts`)

The `PrologInferenceEngine` provides a more powerful, albeit asynchronous, logic layer using `tau-prolog`. It is used when complex queries or advanced logical predicates (symmetry, inverse) are required.

*   **Program Generation (`generatePrologProgram`)**: This function transforms the `CnlGraphData` into a valid Prolog program string.
    *   **Nodes/Attributes**: Converted to `node(Id, Name, Role).` and `attribute(NodeId, Name, Value).`.
    *   **Edges**: Explicit edges are asserted as `explicit_relation(Source, Target, RelName).`.
    *   **Schema Rules**: The engine injects Prolog rules for:
        *   **Symmetry**: `relation(X, Y, R) :- symmetric(R), explicit_relation(Y, X, R).`
        *   **Inverse**: `relation(X, Y, Inv) :- inverse(R, Inv), explicit_relation(Y, X, R).`
        *   **Transitivity**: Uses a cycle-safe recursive predicate (`treach`) with a visited-path accumulator to prevent stack overflows.
*   **Bridge Logic**: The `prolog-bridge.ts` handles the translation of Prolog's string-based answers back into JavaScript objects (`QueryBindings`) by parsing the `X = value` format returned by the `tau-prolan` session.

### 3. Attribute Inheritance (`inheritance.ts`)

While the engines handle edge inference, the `getInheritedAttributes` function manages the vertical propagation of properties.

*   **Hierarchy Traversal**: The engine walks up the graph via `is_a`, `instance_of`, and `member_of` edges.
*   **Override Logic**: It implements a "nearest-ancestor" wins strategy. An attribute defined directly on a node (the most specific context) overrides an attribute found higher in the hierarchy.
*   **Negation Handling**: The engine explicitly ignores negated attributes (`!`) during inheritance, as a negation is a non-fact and cannot serve as a basis for property propagation.

## Data Structures & Interfaces

### `InferenceEngine` Interface
The primary abstraction allowing for interchangeable implementation strategies:

| Method | Parameters | Returns | Description |
| :--- | :--- | :--- | :--- |
| `infer` | `graphData, schemas` | `InferenceResult` | Synchronous discovery of transitive edges. |
| `inferAsync` | `graphData, schemas, queries?` | `Promise<PrologInferenceResult>` | Asynchronous execution of complex logic and Wh-queries. |

### Prolog Program Structure (Generated)
The generated `.pl` string follows this pattern:

```prolog
% Schema Metadata
:- dynamic(transitive/1).
transitive('is_a').

% Facts from Graph
node('human', 'Human', 'class').
explicit_relation('socrates', 'human', 'is_a').
attribute('human', 'mortal', 'true').

% Derived Rules
relation(X, Y, R) :- explicit_relation(X, Y, R).
relation(X, Y, R) :- symmetric(R), explicit_relation(Y, X, R).
```

## Implementation Constraints

*   **Memory & Recursion**: In the `PrologInferenceEngine`, a `limit` (inference depth/step count) must be passed to the `TauSession` to prevent infinite recursion in highly cyclic graphs.
*   **String Sanitization**: All node IDs and names must be passed through `prologAtom()` before being injected into the Prolog program to escape single quotes and backslashes, preventing syntax errors in the logic engine.
*   **Negation Constraints**: Negated edges (`negated: true`) are never asserted as positive facts in Prolog. This ensures they do not inadvertently trigger transitive or symmetric rules.

## Current Behavior vs. Known Gaps

| Feature | Status | Implementation Detail |
| :--- | :--- | :--- |
| **Transitive Closure** | Complete | Implemented via BFS in `TransitiveClosureEngine`. |
| **Symmetry/Inverse** | Complete | Handled via Prolog rules in `prolog-bridge.ts`. |
| **Membership Inheritance**| Complete | `member_of` + `is_a` $\to$ `member_of` implemented. |
| **Attribute Overriding** | Complete | Nearest ancestor wins logic in `inheritance.ts`. |
| **User Wh-Queries** | Complete | Supported via `executePrologQueries`. |
| **Dynamic Rule Injection**| Partial | Only supports predefined relation types (symmetry, etc.). |
| **Complexity Scaling** | Partial | Large graphs may hit the Tau Prolog inference limit. |

## Related Specifications

*   [CNL Parsing & Operations](01_cnli_parsing___operations_.md)
*   [Graph Construction (Operations to Graph)](03_graph_construction__operations_to_graph__.md)
*   [Mathematical Expression Evaluation](05_mathematical_expression_evaluation_.md)
*   [Schema & Type System](06_schema___type_system_.md)
