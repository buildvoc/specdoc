# Task-Centric Domain Model

The Task-Centric Domain Model defines the core business entity of the PIC2BIMAndroid application. The `Task` serves as the fundamental unit of work, acting as a digital "work order" or "job ticket." It is responsible for tracking its own lifecycle, managing associated metadata, and acting as a container for physical evidence (such as captured photos and sensor data) collected during field operations.

## Purpose and Responsibility

The `Task` subsystem is responsible for:
1.  **Lifecycle Management**: Tracking the progression of a task through various states (from `NEW` to `CLOSE`).
2.  **Data Encapsulation**: Serving as the primary container for all related evidence, including photo references and notes.
3.  **Synchronization Orchestration**: Managing the complex logic required to synchronize task status and associated photos with the remote server, specifically handling multi-request uploads to bypass payload size limitations.
4.  **State Integrity**: Enforcing business rules regarding whether a task is "editable" or "sendable" based on its current status and previous synchronization results.

## Architecture and Data Flow

The `Task` model is implemented as a Room `@Entity`, meaning it is the primary object persisted within the [Persistence Layer (Room Database)](05_persistence_layer__room_database__.md). 

### Data Flow Patterns
*   **Ingress (Server to Local)**: Remote JSON payloads are parsed via `Task.createFromResponse`. The model maps JSON keys to local fields and populates a `PhotoRealIdsCollector` to manage incoming photo references.
*   **Egress (Local to Server)**: The task utilizes a `Requestor` abstraction to execute network requests. 
    *   For simple status updates, a single request is dispatched via `updateStatus`.
    *   For complex evidence uploads, the model implements a multi-stage flow where individual photos are uploaded sequentially/concurrently before the final task status update is triggered.

### Dependencies and Interfaces
*   **Persistence**: [Persistence Layer (Room Database)](05_persistence_layer__room_database__.md) for local state.
*   **Networking**: Relies on a `Requestor` interface for authenticated HTTP communication.
*   **Concurrency**: Uses `Phaser`, `CountDownLatch`, and `ExecutorService` to manage the synchronization of multiple asynchronous photo upload requests.
*   **Internal Callback Mechanism**: Employs `UpdateTaskReceiver` (a specialized `UpdateReceiver`) to notify the UI or calling services of successful or failed synchronization operations.

## Implementation Details

### Task Lifecycle (State Machine)
The task transitions through a predefined set of statuses defined in the `STATUS` enum:
`NEW` $\rightarrow$ `OPEN` $\rightarrow$ `RETURNED` $\rightarrow$ `DATA_PROVIDED` $\rightarrow$ `DATA_CHECKED` $\rightarrow$ `CLOSE`.

Business logic constraints are applied to these states:
*   **`isEditable()`**: A task is only editable if its status is `OPEN` or `RETURNED` and the last synchronization attempt did not fail (`!isLastSendFailed`).
*   **`isSendable()`**: A task is eligible for transmission if its status is `OPEN` or `RETURNED`.

### Multi-Request Synchronization Logic
To ensure reliability when uploading large amounts of data, the implementation avoids the deprecated single-request method in favor of `updateCompleteInMultipleRequest`. 

```mermaid
sequenceDiagram
    participant T as Task Model
    participant R as Requestor (Network)
    participant P as Photo List
    participant DB as AppDatabase

    T->>R: Initiate updateCompleteInMultipleRequest
    loop For each Photo in PhotoList
        T->>R: POST /comm_photo.php (Photo Data)
        R-->>T: Response (New Photo Real ID)
        T->/T: Update photo local ID and refresh DB
    end
    Note over T, R: All photo requests must complete
    T->>R: POST /comm_status.php (Task Status & Note)
    R-->>T: Response (Status OK)
    T->>DB: updateTask(this)
    T->>UpdateTaskReceiver: successExec()
```

### Photo Association Management
The `PhotoRealIdsCollector` handles the reconciliation of photo IDs. When a task is updated from the server, the collector identifies:
*   **New IDs**: Photos that need to be downloaded/added to the local database.
*   **Removed IDs**: Photos no longer associated with the task in the remote system.
*   **Updated IDs**: Existing photos whose metadata or assignments have changed.

## Current Behavior and Constraints

*   **Current Implementation**: The model handles both owned tasks (assigned to a `userId`) and "unowned" photo processing (handling photos that are not yet assigned to a specific task).
*   **Constraints**: 
    *   The `isLastSendFailed` flag acts as a circuit breaker, preventing edits to tasks that failed their last synchronization attempt until the error is resolved.
    *   Data parsing is strictly tied to the `DATETIME_FORMAT` (`yyyy-MM-dd HH:mm:ss`).

## Known Gaps and Future Requirements

*   **Gap**: The logic for handling photo synchronization within the task model currently requires manual triggering of `updatePhotosByRealIds`.
*   **Gap**: Error recovery is largely reactive; the model flags `isLastSendFailed` but does not internally implement a retry policy (this is intended to be handled by the [SyncQueue Orchestrator](06_syncqueue_orchestrator_.md)).
*   **Future Requirement**: Refactoring of the photo synchronization logic is noted in the code to decouple photo-specific error handling from the task status update flow.

## Related Specifications

*   [Path Tracking System (PTService)](02_path_tracking_system__ptservice__.md)
*   [Tiered Location Sourcing](03_tiered_location_sourcing_.md)
*   [EKF (Extended Kalman Filter) Engine](04_ekf__extended_kalman_filter__engine_.md)
*   [Persistence Layer (Room Database)](05_persistence_layer__room_database__.md)
*   [SyncQueue Orchestrator](06_syncqueue_orchestrator_.md)
