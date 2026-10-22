# Schema & Type System

While [Mathematical Expression Evaluation](05_mathematical_expression_evaluation_.md) provides the logic for computing values within the graph, the **Schema & Type System** defines the structural constraints and semantic boundaries of the graph itself. It establishes the "rules of reality" by specifying which node types can exist, what attributes are valid for specific domains, and how relationships are permitted to connect various entities.

## System Overview

The Schema subsystem acts as a validation and definition layer. It manages two sets of definitions:
1.  **Default Schemas**: A hardcoded set of fundamental types (e.g., `class`, `individual`, `Resource`, `Event`) that ensure the engine has a baseline understanding of common entities.
2.  **User-Defined Schemas**: Custom definitions provided via `nodeBook-schema` code blocks, allowing users to extend the graph's vocabulary with domain-specific types (e.g., specialized chemical substances or financial accounts).

The system is responsible for merging these two layers, parsing new definitions from text, and validating that incoming [Graph Construction](03_graph_construction__operations_to_graph__.md) operations do not violate the established rules.

## System Architecture & Data Flow

The subsystem operates as a centralized store that serves both the parser (for ingestion) and the validator (for enforcement).

```mermaid
graph TD
    subgraph "Schema Definition Sources"
        A[Hardcoded Defaults - schemas.ts]
        B[User Schema Blocks - nodeBook-schema]
    end

    subron "Parsing Engine (schema-parser.ts)"
        B --> C[parseSchemaBlock]
        C --> D[Structured ParsedUserSchemas]
    end

    subgraph "Schema Management (schema-store.ts)"
        D --> E[mergeSchemaResults]
        A --> F[getMergedSchemas]
        E --> F
        F --> G[MergedSchemas Object]
    end

    subgraph "Validation Engine (validate-operations.ts)"
        G --> H[validateOperations]
        I[CnlOperation[] Array] --> H
        H --> J[CnlParseError[]]
    end

    subgraph "Serialization (serialize-schemas.ts)"
        G --> K[serializeSchemas]
        K --> L[Textual Schema Representation]
    end
```

## Internal Implementation

The subsystem is implemented across several specialized modules in `packages/nodebook-core/src/`.

### 1. Schema Storage and Merging (`schema-store.ts`)

This module manages the global state of the active schema. It implements a versioned store to track changes when new schemas are loaded.

*   **`getMergedSchemas()`**: The primary accessor for the application. It retrieves the `currentUserSchemas` and performs a name-based merge with the `defaultNodeTypes`, `defaultRelationTypes`, etc.
*   **`mergeByName<T>()`**: A utility that ensures if a user defines a type with the same name as a default (e.g., redefining `class`), the user's version takes precedence, effectively allowing for schema overrides.
*   **Versioning**: The `storeVersion` is incremented every time `setUserSchemas` is called, allowing the UI or other subsystems to detect when the "rules of reality" have changed and trigger a re-validation.

### 2. Schema Parsing (`schema-parser.ts`)

The parser implements a custom grammar for the `nodeBook-schema` block format. It processes text line-by-line, identifying the type of definition via a prefix (e.g., `nodeType:`).

*   **Field Extraction**: The engine uses `splitFields` to handle comma-separated values while respecting quoted strings (to allow commas within descriptions).
*   **Prefix Routing**: Based on the detected prefix, the parser routes the line to specific handlers:
    *   `parseNodeTypeLine`: Extracts name, description, and `parent_types`.
    *   `parseRelationTypeLine`: Extracts domain, range, symmetry, transitivity, and inverse relationships.
    *   `parseAttributeTypeLine`: Extracts data types (e.g., `float`, `string`), units, and allowed value sets.
    *   `parseFunctionTypeLine`: Extracts the mathematical definition and required scope.

### 3. Operation Validation (`validate-operations.ts`)

This module provides the enforcement mechanism. It iterates through a `CnlOperation[]` array (produced by [CNL Parsing & Operations](01_cnl_parsing___operations_.md)) and checks them against the `MergedSchemas`.

*   **Type Checking**:
    *   Validates that any `role` assigned to a node in an `addNode` operation exists within the `nodeTypes` schema.
    *   Ensures `addAttribute` operations reference valid `attributeTypes`.
    *   Ensures `addRelation` operations reference valid `relationTypes`.
*   **Semantic Constraint Enforcement**: The validator implements specific logic for complex relations. For example, it enforces that the `is_a` relation (subsumption) can only connect two `class` types, and will raise an error if attempted between an `individual` and a `class`.
*   **Identity Warning**: It tracks "surface forms" (the display names used in text). If multiple different strings (e.g., "Human" and "Humans") are mapped to the same normalized ID (`human`), it issues a warning about potential consolidation confusion.

### 4. Serialization (`serialize-schemas.ts`)

To allow users to edit or view their schemas, this module implements the reverse of the parser. It iterates through the `MergedSchemas` and reconstructs the specialized string format used in `nodeBook-schema` blocks.

## Data Structures

### MergedSchemas Interface
The core payload representing the complete rulebook:

| Property | Type | Description |
| :--- | :--- | :--- |
| `nodeTypes` | `NodeTypeSchema[]` | Definitions for categories and instances. |
| `relationTypes` | `RelationTypeSchema[]` | Rules for edges (domain, range, symmetry). |
| `attributeTypes` | `AttributeTypeSchema[]` | Constraints on node properties (units, types). |
| `transitionTypes`| `TransitionTypeSchema[]`| Definitions for process-based nodes. |
| `functionTypes` | `FunctionTypeSchema[]` | Computational definitions and their scopes. |

## Implementation Constraints

*   **Last-Write-Wins**: When merging user schemas with defaults, the user's definition always overwrites the default if names collide.
*   **Complexity**: Validation is $O(O \cdot S)$ where $O$ is the number of operations and $S$ is the number of schema definitions, though lookups are optimized via `Map` structures in the merge process.
*   **Advisory Errors**: The validation engine distinguishes between critical structural errors and "advisory" warnings (like name consolidation). Validation does not stop the graph from rendering but notifies the user of potential logic flaws.

## Current Behavior vs. Known Gaps

| Feature | Status | Implementation Detail |
| :--- | :--- | :--- |
| **Schema Merging** | Complete | Supports overriding defaults with user definitions. |
| **Type Validation** | Complete | Validates node roles, attribute names, and relation types. |
| **Semantic Rules** | Partial | Currently only enforces `is_a` constraints for individuals. |
| **Complex Attributes**| Not Implemented | The serializer skips attributes with complex nested structures. |
| **Schema Persistence**| Partial | Schemas are managed in-memory; requires external storage logic. |

## Related Specifications

*   [CNL Parsing & Operations](01_cnl_parsing___operations_.md)
*   [Graph Construction (Operations to Graph)](03_graph_construction__operations_to_graph__.md)
*   [Mathematical Expression Evaluation](05_mathematical_expression_evaluation_.md)
*   [Inference Engine (Prolog & Transitive Closure)](07_inference_engine__prolog___transitive_closure__.md)
