# Progressive Data Streaming (SSE)

Following the high-performance rendering capabilities established in [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md), the Progressive Data Streaming (SSE) subsystem provides the network communication pattern required to ingest massive geospatial datasets without compromising browser responsiveness.

## Purpose and Responsibility

The Progressive Data Streaming subsystem is responsible for managing long-lived HTTP connections using the Server-Sent Events (SSE) protocol. Its primary objective is to prevent "UI freezing" during the loading of large-scale datasets (such as Building Parts, NHLE, or Land Registry data) by processing incoming data in discrete, manageable chunks.

The subsystem implements a streaming consumer that intercepts `text/event-stream` responses, decodes binary chunks into UTF-8 strings, and parses individual JSON events. It is responsible for:
1.  **Incremental Data Accumulation:** Building the full dataset in memory while simultaneously exposing partial results to the UI.
2.  **Progress Reporting:** Providing real-time feedback via callbacks (`onProgress`) regarding total counts, loaded items, and current throughput.
3.  **Concurrency Control:** Orchestrating multiple simultaneous streams through a batching and throttling mechanism to prevent network congestion.

## Architecture and Data Flow

The subsystem operates as a stream-processing pipeline that sits between the Laravel backend and the [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md) layers. It utilizes the Web Streams API (`ReadableStream`) to process data as it arrives from the network buffer.

### System Components
* **Streaming Fetcher:** A specialized implementation of the `fetch` API configured with `Accept: text/event-stream` and CSRF authentication.
* **Buffer Manager:** A logic layer that manages an internal string buffer to handle "split" messages (where a single SSE event is fragmented across two network packets).
* **Event Dispatcher:** An asynchronous loop that iterates through parsed JSON events (`metadata`, `chunk`, `complete`) and triggers the `onProgress` callback.
* **Batch Orchestrator (`loadAllDataBatched`):** A high-level controller that manages multiple data streams using a queue-based throttling strategy to limit concurrent active requests.

### Data Flow Diagram: SSE Chunk Processing
The following diagram illustrates how raw network bytes are transformed into renderable geospatial features.

```mermaid
sequenceDiagram
    participant Server as Laravel Backend (SSE)
    participant Fetch as Fetch API / ReadableStream
    participant Decoder as TextDecoder & Buffer
    participant Parser as JSON Parser
    participant UI as React/Deck.gl Layer

    Server->>Fetch: Transmits Byte Chunk (Encoded)
    Fetch->>Decoder: Stream Segment
    Note right of Decoder: buffer += chunk; split('\n')
    Decoder->>Parser: Extracted 'data: {...}' string
    Parser->>UI: Trigger onProgress({type: 'chunk', chunkData: [...]})
    Note left of UI: Immediate Layer Update (Incremental Render)
    Server->>Parser: Event 'type: complete'
    Parser->>UI: Finalize Data Load
```

### Dependencies and Interfaces
* **Core Dependencies:** Standard Web APIs (`ReadableStream`, `TextDecoder`, `Fetch`), `axios` (for standard requests).
* **Internal Interfaces:**
    * `LazyLoadOptions`: Configuration for area filtering and feature toggles.
    * `onProgress`: A callback signature: 
      `(progress: { type: string; progress?: number; loaded?: number; total?: number; chunkData?: any }) => void`.
* **External Constraints:** Requires a backend capable of maintaining open HTTP connections and flushing the output buffer frequently to prevent latency.

## Technical Implementation Details

### Stream Consumption and Line Buffering
The core logic for all streaming functions (e.g., `loadBuildingPartsStream`, `loadSitesStream`) is implemented in `resources/js/DataMap/api/lazyLoadData.ts`. A critical challenge in SSE is handling partial lines; the implementation uses a buffer-and-pop strategy to ensure data integrity.

```typescript
// Implementation of line buffering in loadBuildingPartsStream
let buffer = '';

const readStream = () => {
  reader.read().then(({ done, value }) => {
    if (done) { resolve(allData); return; }
    
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk; // Append new bytes to the existing buffer
    
    const lines = buffer.split('\n');
    // The last element is either an empty string or a partial line; 
    // we pop it and save it back into the buffer for the next iteration.
    buffer = lines.pop() || ''; 
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        // Process complete JSON event...
      }
    }
    readStream();
  });
};
```

### Data Format Normalization
The subsystem is designed to be format-agnostic, handling various incoming JSON structures from different backend endpoints. It detects whether a chunk contains a raw array, a GeoJSON `FeatureCollection`, or a single object, and normalizes them into a consistent structure for the UI.

**File:** `resources/js/DataMap/api/lazyLoadData.ts`

```typescript
// Logic for handling heterogeneous chunk formats
if (Array.isArray(data.data)) {
  // Format: Direct Array (e.g., Sites, NHLE)
  chunkData = data.data;
  allData.push(...data.data);
} else if (data.data?.features && Array.isArray(data.data.features)) {
  // Format: GeoJSON FeatureCollection (e.g., Building Parts)
  chunkData = data.data.features;
  allData.push(...data.data.features);
}
```

### Throttled Batch Loading
The `loadAllDataBatched` function implements a sophisticated loading strategy that divides datasets into priority tiers:
1.  **Batch 1 (Critical):** High-priority layers (NHLE, Sites, Photos) loaded via `Promise.allSettled`.
2.  **Batch 2 (Heavy):** Large geometric datasets (Building Parts, Land Registry) loaded sequentially.
3.  **Batch 3 (Optional/Throttled):** Low-priority datasets (UPRN, EPC, OSM) managed by `throttleRequests` to ensure no more than 2 concurrent streams are active.

## Current Behavior
* **Incremental Rendering:** The UI updates immediately as each chunk arrives via the `onProgress` callback, allowing users to see building footprints before the entire city is loaded.
* **Memory Efficiency:** By using a stream reader, the system avoids loading the entire multi-megabyte JSON payload into a single string before parsing.
* **Concurrency Management:** The throttling mechanism prevents the browser from hitting maximum concurrent connection limits when requesting multiple datasets.

## Known Gaps
* **Hardcoded Chunk Sizes:** Parameters like `chunk_size: 100` or `chunk_size: 20` are hardcoded within individual functions, preventing dynamic optimization based on network conditions.
* **Lack of Retry Logic:** If an SSE stream is interrupted due to a network hiccup, the current implementation fails the promise and does not attempt to resume from the last known byte/index.
* **No Client-Side Persistence:** There is no mechanism to cache previously streamed chunks in `IndexedDB`, requiring full re-downloads on every session.

## Future Requirements
* **Adaptive Chunking:** Integration with [Spatial Data Filtering & Processing](07_spatial_data_filtering___processing_.md) to dynamically adjust the `chunk_size` based on the zoom level and viewport complexity.
* **Resumable Streams:** Implementation of a "Range-like" mechanism for SSE, allowing the client to request data starting from a specific sequence ID after an interruption.

## Related Specifications
* [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md)
* [Spatial Data Filtering & Processing](07_spatial_data_filtering___processing_.md)
