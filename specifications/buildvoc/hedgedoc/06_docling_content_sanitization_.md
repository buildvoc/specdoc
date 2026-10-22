# Docling Content Sanitization

While [Document Indexing and Summarization](05_document_indexing_and_summarization_.md) manages the retrieval of historical summaries for context construction, the **Docling Content Sanitization** subsystem is responsible for the structural purification of the active source being processed. It acts as a high-fidelity filter within the [Memex Processing Pipeline](04_memex_processing_pipeline_.md), ensuring that highly structured, machine-generated inputs—specifically those following the Docling JSON schema—are stripped of high-entropy, token-intensive metadata before reaching the LLM.

The primary objective is to prevent "context poisoning" and context window exhaustion caused by embedded Base64 images, large structural references, and redundant metadata that provide no semantic value to the [LLM Orchestration & Chat Interface](01_llm_orchestration___chat_interface_.md).

## Architecture & Data Flow

The sanitization logic is an inline transformation step within the ingestion phase of the pipeline. It intercepts raw content fetched from the HedgeDoc API and transforms it based on its detected encoding format.

```mermaid
graph TD
    A[Raw Content Ingested] --> B{Format Detection}
    B -->|Standard Markdown| C[Markdown Sanitization]
    B -->|Docling JSON Schema| D[Recursive JSON Pruning]
    
    subgraph "Markdown Sanitization"
    C --> C1[Regex: Remove ![alt](data:...) ]
    end

    subgraph "Docling JSON Pruning"
    D --> D1[Identify DoclingDocument Schema]
    D1 --> D2[Recursive Tree Traversal]
    D2 --> D3[Prune 'pictures' keys]
    D2 --> D4[Remove '$ref' to image objects]
    D2 --> D5[Strip Base64 strings in text nodes]
    end

    C1 --> E[Cleaned Semantic Content]
    D5 --> E
    E --> F[Passed to Prompt Construction]
```

### Implementation Constraints
*   **Structural Integrity:** For Docling JSON, the subsystem must preserve the original text prefix and suffix (the non-JSON parts of the file) to ensure the valid JSON block remains correctly embedded in the source.
*   ly **Non-Destructive Parsing:** The system uses a "drop" mechanism during recursive traversal; if an object is identified as a reference to an image, it is removed from the tree rather than just being emptied, reducing the total number of nodes.
*   **Token Efficiency:** The transformation must prioritize the removal of string patterns that represent high-token density with low semantic utility (e.g., `data:image/png;base64,...`).

## Internal Implementation

The core logic is implemented in the `sanitize_llm_source` function within `memex/process_queue_once.py`.

### 1. Markdown Sanitization
For standard Markdown documents, the implementation uses a compiled regular expression to identify and replace embedded Base64 images with a lightweight placeholder: `[MARKDOWN_IMAGE_REMOVED]`. This prevents the LLM from attempting to "read" or summarize raw binary-to-text strings.

### 2. Docling JSON Pruning
When the input text contains a JSON block identified by `"schema_name": "DoclingDocument"`, the subsystem initiates a recursive descent parser. The `clean(value)` inner function performs the following operations:

*   **Dictionary Pruning:** It iterates through all keys in a dictionary. If a key is named `pictures`, it is deleted entirely from the current level of the tree.
*   **Reference Removal:** It inspects `$ref` and `self_ref` keys. If the value points to a structural element within the `#/pictures/` path, that entire node is dropped from the tree using a sentinel `DROP` object.
*   **String Sanitization:** Within any text node (string value), it applies regex to strip out:
    1.  Markdown-style image syntax containing Base64 data.
    2.  Raw `data:image/...;base64,...` patterns.
*   **Re-serialization:** After the tree is pruned, the sanitized dictionary is re-serialized into a compact JSON string (using `separators=(",", ":")`) and merged back with the original file prefix.

### Code Implementation Detail

The following excerpt from `memex/process_queue_once.py` demonstrates the recursive pruning logic:

```python
def clean(value):
    if isinstance(value, dict):
        # Prune keys that point to heavy image metadata
        for ref_key in ("$ref", "self_ref"):
            if value.get(ref_key, "").startswith("#/pictures/"):
                return DROP # Sentinel to remove this node

        cleaned = {}
        for key, item in value.items():
            # Completely strip the 'pictures' structural key
            if key == "pictures":
                continue
            result = clean(item)
            if result is not DROP:
                cleaned[key] = result
        return cleaned

    if isinstance(value, str):
        # Strip embedded Base64 and Markdown image syntax from text nodes
        value, n_data = data_image_re.subn("[EMBEDDED_IMAGE_REMOVED]", value)
        value, n_md = markdown_image_re.subn("[MARKDOWN_IMAGE_REMOVED]", value)
        return value

    # ... (list handling and return logic)
```

## Current vs. Future Requirements

### CURRENT Behavior
*   **Format Support:** Handles both standard Markdown and Docling-formatted JSON.
*   **Image Stripping:** Successfully identifies and removes Base64-encoded images and their structural references in the Docling tree.
*   **Schema Awareness:** Specifically targets the `DoclingDocument` schema for deep pruning.
*   **Token Optimization:** Reduces payload size by removing high-entropy strings that would otherwise consume significant context window space.

### KNOWN GAPS
*   **Other Structured Formats:** The system currently lacks specialized sanitizers for other machine-generated formats (e.g., XML or heavy CSV exports) that might be introduced into the pipeline.
*   **Table Complexity:** While it strips images from tables, it does not yet prune extremely large/wide tables that are semantically valid but contextually overwhelming.

### FUTURE REQUIREMENTS
*   **Structural Thresholds:** Implementation of a "Complexity Limit" where if a JSON tree exceeds a certain depth or node count, the system triggers an automated structural simplification (e.g., collapsing deep nests into summaries).
*   **Multi-Format Plugins:** A plugin-based architecture for `sanitize_llm_source` to allow easy addition of new document format cleaners as the ecosystem expands.

## Related Specifications
*   [LLM Orchestration & Chat Interface](01_llm_orchestration___chat_interface_.md)
*   [Memex Processing Pipeline](04_memex_processing_pipeline_.md)
*   [Document Indexing and Summarization](05_document_indexing_and_summarization_.md)
