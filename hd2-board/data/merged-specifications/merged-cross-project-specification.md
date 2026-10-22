# Merged Cross-Project Specification

> **Merged specification provenance:** Generated from 13 existing SpecDoc specification document(s) across 2 project(s). Repository source code was not supplied to or inspected by the merge model. Model: `gemma4:26b`.
> **Template:** Original SpecDoc section template copied from `buildvoc/PIC2BIM/01_unified_task___user_management__inertia_js__.md`.
> **Projects:** `buildvoc/PIC2BIM`, `buildvoc/PIC2BIMAndroid`


## Purpose and Responsibility

### Web-Based Administrative & Visualization Core (buildvoc/PIC2BIM)
*   **Administrative Core:** Managing the lifecycle of organizational entities ("Officers", "Farmers"), task types, and operational status of assigned tasks.
*   **Metadata Extraction:** Parsing image headers to automate extraction of GPS, altitude, and timestamps for verifiable audit trails.
*   **3D Spatial Orchestration:** Managing camera projection modes (First Person, Map, Orthographic) and synchronizing 3D layers (GeoJSON, LAS, Photo Icons) within a unified WebGL context.
*   **Large-Scale Data Retrieval:** Efficiently managing high-density terrain/elevation data via single-file archives (.pmtiles) to minimize HTTP requests.
*   **High-Performance WebGL Rendering:** Managing the lifecycle and spatial synchronization of specialized layers including 3D Scenegraphs, Point Clouds, and Dynamic Icons.
*   **Network Stream Ingestion:** Managing long-lived HTTP connections via SSE to ingest massive datasets without UI freezing through incremental data accumulation.
*   **Spatial Reduction & Refinement:** Real-time reduction of geographic datasets based on user-defined spatial boundaries and attribute properties.

### Android-Based Task & Spatial Tracking Subsystems (buildvoc/PIC2BIMAndroid)
*   **Mobile Work Order Management:** Acting as a digital "work order" to track task progression, encapsulate evidence (photos/notes), and orchestrate synchronization with remote servers.
*   **Path Tracking System (PTService):** Responsible for trajectory recording (`PTPath`), session lifecycle management (`START/STOPPED`), and spatial data integrity.
*   **Tiered Location Sourcing:** Responsible for multi-layered acquisition (Fused, Standard GPS, High-Precision GNSS) and data normalization into a unified `LocationResult` format; manages NMEA/Inav parsing via `LMManager` and centroid calculation via `GrahamScan`.
*   **EKF (Extended Kalman Filter) Engine:** Acts as the computational core for PVT (Position, $\text{Velocity}$, $\text{Time}$) estimation; manages multi-frequency/multi-constellation processing and applies physical corrections (Shapiro, Tropospheric, Ionospheric).
*   **Data Management & Orchestration:** 
    *   **Persistence Layer (Room Database):** Provides durable, structured storage for Tasks, Photos, and Paths; manages relational integrity, schema evolution (v42–v54), and local state management.
    *   **SyncQueue Orchestrator:** Manages sequential execution of asynchronous tasks (`AsyncExecutor`), ensuring task chaining and preventing concurrent resource exhaustion during network/IO operations.

## Architecture and Data Flow

### Web Architecture (buildvoc/PIC2BIM)
*   **State Management:** Uses Inertia.js `router` for server-driven state management.
*   **Data Protocols:** Utilizes the `pmtiles://` URI scheme for tile retrieval via HTTP Range Requests; uses `text/event-stream` (SSE) for progressive data streaming and incremental layer updates.
*   **Spatial Context:** A unified WebGL context manages 3D layers including GeoJSON, LAS, and Photo Icons using `@deck.gl` and `maplibre-gl`.

### Android Architecture (buildvoc/PIC2BIMAndroid)
*   **Location Pipeline:** Hardware events (GPS/GNSS) $\rightarrow$ EKF processing via `StaticExtendedKalmanFilter` $\rightarrow$ `PTService` Ingress (applying State and Temporal filters) $\rightarrow$ Recording to `PTPath`.
*   **Synchronization Pipeline:** `SyncQueue` triggers a chain of `AsyncExecutor` tasks $\rightarrow$ Sequential execution $\rightarrow$ `executionFinish()` triggers the next task via `indxToExec`.
*   **Data Persistence:** Local state is managed via Room Database, providing structured storage for Tasks, Photos, and Paths.

### Cross-Project Integration Flow
*   The Android subsystem captures spatial evidence (photos/paths) and manages local lifecycle transitions; these are subsequently synchronized to the server where the Web system processes metadata (EXIF), updates task statuses, and provides large-scale visualization of the collected data.

## Technical Implementation Details

### Web Implementation (buildvoc/PIC2BIM)
*   **Frontend Stack:** `@inertiajs/react`, `react`, `lucide-react`, `@fortawesome/react-fontawesome`, `@mui/material`, `@mui/icons-material`, `maplibre-gl`, `@deck.gl/core`, `@deck.gl/layers`, `@loaders.gl/las`, `@turf/turf`, `@math.gl/core`, `axios`.
*   **Backend & Protocol:** Laravel, PostgreSQL/MySQL, PMTiles (v4.1.0), Web Streams API.
*   **Key Data Structures:** `PageProps` (global object containing `auth.user`, `tasks`, etc.); `PaginatedDataExtended<T>`; `Tag` (structural type for attributes); `tags: Record<string, Tag[] | Tag>` (dictionary of EXHD metadata); `MultivallyMapViewState` (dual-latency structure for Map and First Person views).

### Android Implementation (buildvoc/PIC2BIMAndroid)
*   **Libraries & APIs:** Room Database, Google Play Services (`FusedLocationProviderClient`), Android `LocationManager`, GNSS Measurements API, `eu.foxcom.gnss_compare_core` (EKF math), Joda-Time (`DateTime`), SQLite.
*   **Key Data Structures:** `Task` as a Room `@Entity`; `STATUS` enum (`NEW`, `OPEN`, `RETURNED`, `DATA_PROVIDED`, `DATA_CHECKED`, `CLOSE`); `PTPath` (`name`, `area`, `isUploadingOpened`, sequence of `PTPoint`); `PTPoint` (`latitude`, `longitude`, `timestamp`); `LocationResult` (unified format for Fused, Standard, and GNSS inputs); `EkfData` (`latitude`, `longitude`, `altitude`, `referenceTime`, `computedTime`); `AsyncExecutor` (encapsulated unit of work).

## Current Behavior

### Web Functionality (buildvoc/PIC2BIM)
*   **Task Management:** Bulk operations on tasks and real-time progress reporting for data streams.
*   **Automated Processing:** Automated extraction of EXIF metadata from uploaded images.
*   **Visualization:** Seamless switching between camera perspectives; multi-criteria filtering (spatial and attribute-based); real-time updates to layers via SSE.

### Android Functionality (buildvoc/PIC2BIMAndroid)
*   **Task Lifecycle:** Tracking tasks from `NEW` to `CLOSE`; enforcement of "editable" and "sendable" business rules.
*   **Evidence Collection:** Multi-stage evidence upload (photos are uploaded before status updates); trajectory recording via path tracking.
*   **Synchronization:** Sequential execution of network/IO tasks through a managed queue to prevent resource exhaustion.

## Known Gaps

### Web-Specific Gaps (buildvoc/PIC/BIM)
*   **UI/UX:** Lacks a dedicated toast notification system; lacks granular loading indicators for large LAS chunks.
*   **Performance:** Spatial filtering has $O(N \times M)$ complexity and lacks spatial indexing (R-tree); lacks explicit logic to purge GPU buffers for large point clouds.
*   **Reliability:** SSE lacks retry logic and client-side persistence; lacks client-side file validation for uploads.

### Android-Specific Gaps (buildvoc/PIC2BIMAndroid)
*   **Error Handling:** Error recovery is reactive and lacks an internal retry policy for failed location updates or `AsyncExecutor` units; no standardized interface for an `AsyncExecutor` to notify the `SyncQueue` to skip or halt on failure.
*   **System Automation:** No automated "hot-swap" between location tiers (e.g., GNSS to Fused) upon signal loss; EKF module management is manual rather than configuration-driven; transition to fully automated centroid-driven mode is incomplete.
*   **Data Integrity & Risk:** Photo binary data is managed externally, creating a potential synchronization risk with the file system; `GNSSManager` uses fixed-size arrays which may overflow if configuration changes mid-session.
*   **Testing/Maintenance:** No documented automated test suite for verifying all 12+ Room database migration paths (v42–v54).

### Cross-Project Conflicts
*   **State Management Discrepancy:** The Web system uses Inertia.js for server-driven state management, whereas the Android system manages local state via Room Database.

## Future Requirements
The available evidence does not specify future requirements.

## Related Specifications

| Element | Source Namespace | Source Filename |
| :--- | :--- | :--- |
| Task/User Management | `buildvoc/PIC2BIM` | `01_unified_task___user_management__inertia_js__.md` |
| EXIF Extraction | `buildvoc/PIC2BIM` | `02_building_attribute_extraction__exif__.md` |
| Map Orchestration | `buildvoc/PIC2BIM` | `03_multi_view_map_orchestration_.md` |
| PMTiles Protocol | `buildvoc/PIC2BIM` | `04_pmtiles_tiling_protocol_.md` |
| Deck.gl Overlays | `buildvoc/PIC2BIM` | `05_deck_gl_overlay_management_.md` |
| SSE Streaming | `buildvoc/PIC2BIM` | `06_progressive_data_streaming__sse__.md` |
| Spatial Filtering | `buildlam/PIC2BIM` | `07_spatial_data_filtering___processing_.md` |
| Android Task Model | `buildvoc/PIC2BIMAndroid` | `01_task_centric_domain_model_.md` |
| Path Tracking (PTService) | `buildvoc/PIC2BIMAndroid` | `02_path_tracking_system__ptservice__.md` |
| Tiered Location Sourcing | `buildvoc/PIC2BIMAndroid` | `03_tiered_location_sourcing_.md` |
| EKF Engine | `buildvoc/PIC2BIMAndroid` | `04_ekf__extended_kalman_filter__engine_.md` |
| Persistence Layer (Room) | `buildvoc/PIC2BIMAndroid` | `05_persistence_layer__room_database__.md` |
| SyncQueue Orchestrator | `buildvoc/PIC2BIMAndroid` | `06_syncqueue_orchestrator_.md` |
