# Progressive Data Streaming (SSE)

Following the high-performance rendering capabilities established in [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md), the Progressive Data Streaming (SSE) subsystem provides the network communication pattern required to ingest massive geospatial datasets without compromising browser responsiveness.

## Purpose and Responsibility

The Progressive Data Rendering subsystem is responsible for managing long-lived HTTP connections using the Server-Sent Events (SSE) protocol. Its primary objective is to prevent main-thread blocking ("UI freezing") during the loading of large-scale datasets—such as Building Parts, NHLE, or Land Registry data—by processing incoming data in discrete, manageable chunks.

The subsystem implements a streaming consumer that intercepts `text/event-stream` responses, decodes binary chunks into UTF-8 strings, and parses individual JSON events. Its core responsibilities include:
1.  **Incremental Data Accumulation:** Maintaining the full dataset in memory while simultaneously exposing partial results to the UI for immediate rendering.
2.  **Progress Reporting:** Providing real-time telemetry via `onProgress` callbacks, including total item counts, loaded items, and current throughput.
3.  **Concurrency Control:** Orchestrating multiple simultaneous streams through a batching and throttling mechanism to prevent network congestion and browser connection exhaustion.

## Architecture and Data Flow

The subsystem operates as a stream-processing pipeline situated between the Laravel backend and the [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md) layers. It leverages the Web Streams API (`ReadableStream`) to process data segments as they arrive from the network buffer.

### System Components
* **Streaming Fetcher:** A specialized implementation of the `fetch` API configured with `Accept: text/event-stream` and CSRF authentication.
* **Buffer Manager:** A logic layer that manages an internal string buffer to handle "split" messages (where a single SSE event is fragmented across two network packets).
* **Event Dispatcher:** An asynchronous loop that iterates through parsed JSON events (`metadata`, `chunk`, `complete`) and triggers the `onProgress` callback.
* **Batch Orchestrator (`loadAllDataBatched`):** A high-level controller that manages multiple data streams using a queue-based throttling strategy to limit concurrent active requests.

### Data Flow Diagram: SSE Chunk Processing
The following sequence diagram illustrates the transformation of raw network bytes into renderable geospatial features.

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

### Interfaces and Dependencies
* **Core Dependencies:** Standard Web APIs (`ReadableStream`, `TextDecoder`, `Fetch`), `axios`.
* **Internal Interfaces:**
    * `LazyLoadOptions`: Configuration for area filtering and feature toggles.
    * `onProgress`: A callback signature defined as: 
      `(progress: { type: string; progress?: number; loaded?: number; total?: number; chunkData?: any }) => void`.
* **External Constraints:** Requires a backend capable of maintaining open HTTP connections and frequent output buffer flushing to minimize latency.

## Internal Implementation Details

The core logic for stream consumption is implemented in `resources/js/DataMap/api/lazyLoadData.ts`. 

### Stream Consumption and Line Buffering
A critical challenge in SSE processing is handling partial lines where a single event string is split across two network packets. The implementation utilizes a buffer-and-pop strategy to ensure data integrity.

```typescript
// Implementation of line buffering in loadBuildingPartsStream (resources/js/DataMap/api/lazyLoadData.ts)
let buffer = '';

const readStream = () => {
  reader.read().then(({ done, value }) => {
    if (done) { resolve(allData); return; }
    
    // Decode chunk and append to existing internal buffer
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk; 
    
    // Split by newline to identify complete lines
    const lines = buffer.split('\n');

    // The last element is either an empty string or a partial line fragment.
    // We pop it and re-assign it to the buffer for the next iteration.
    buffer = lines.pop() || ''; 
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const eventData = JSON.parse(line.substring(6));
        // Process complete JSON event...
      }
    }
    readStream();
  });
};
```

### Data Format Normalization
The subsystem is format-agnostic, capable of normalizing heterogeneous incoming JSON structures (e.g., raw arrays vs. GeoJSON) into a consistent structure for the [Deck.gl Overlay Management](0ESS_deck_gl_overlay_management_.md) layers.

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

### Throttled Batch Loading Strategy
The `loadAllDataBatched` function implements a priority-based loading strategy, dividing datasets into specific tiers to optimize the user's perceived performance:
1.  **Tier 1 (Critical):** High-priority layers (NHLE, Sites, Photos) are loaded via `Promise.allSettled`.
2.  **Tier 2 (Heavy):** Large geometric datasets (Building Parts, Land Registry) are loaded sequentially to prevent memory spikes.
3.  **Tier 3 (Optional/Throttled):** Low-priority datasets (UPRN, EPC, OSM) are managed by `throttleRequests` to ensure no more than two concurrent streams are active at any time.

## Current Behavior
* **Incremental Rendering:** The UI updates immediately as each chunk arrives via the `onProgress` callback, enabling users to view building footprints before the entire dataset is loaded.
* **Memory Efficiency:** By utilizing a `ReadableStream` reader, the system avoids loading multi-megabyte JSON payloads into a single monolithic string before parsing.
* **Concurrency Management:** The throttling mechanism prevents the browser from reaching the maximum concurrent connection limit per domain when requesting multiple datasets simultaneously.

## Known Gaps
* **Hardcoded Chunk Sizes:** Parameters such as `chunk_size: 100` are hardcoded within individual functions, preventing dynamic optimization based on real-time network conditions.
* **Lack of Retry Logic:** If an SSE stream is interrupted by a network failure, the current implementation fails the promise and does not attempt to resume from the last successfully processed index.
* **No Client-Side Persistence:** There is no mechanism to cache previously streamed chunks in `IndexedDB`, necessitating full re-downloads for every new session.

## Future Requirements
* **Adaptive Chunking:** Integration with [Spatial Data Filtering & Processing](07_spatial_data_filtering___processing_.md) to dynamically adjust the `chunk_size` based on the current zoom level and viewport complexity.
* **Resumable Streams:** Implementation of a "Range-like" mechanism for SSE, allowing the client to request data starting from a specific sequence ID following an interruption.

## Related Specification Documents
* [Deck.gl Overlay Management](05_deck_gl_overlay_management_.md)
* [Spatial Data Filtering & Processing](07_spatial_data_filtering___processing_.md)
