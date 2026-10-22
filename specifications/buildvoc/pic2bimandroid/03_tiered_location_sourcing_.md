# Tiered Location Sourcing

While the [Path Tracking System (PTService)](02_path_tracking_system__ptservice__.md) manages the collection and persistence of spatial trajectories, it relies on the **Tiered Location Sourcing** subsystem to provide the raw geographic data. This subsystem implements a multi-layered strategy for location acquisition, allowing the application to switch between standard Android APIs, raw GPS provider data, and high-precision GNSS processing based on available hardware and required accuracy.

## Purpose and Responsibility

The Tiered Location Sourcing subsystem is responsible for:
1.  **Multi-Layered Acquisition**: Providing three distinct levels of location granularity:
    *   **Fused Level**: Utilizing Google Play Services' `FusedLocationProviderClient` for battery-efficient, standard positioning.
    *   **Standard Provider Level**: Accessing the Android `LocationManager` directly via the GPS provider to capture raw NMEA-like data (e.g., `InavMessage`).
    *   **High-Precision GNSS Level**: Processing raw `GnssMeasurementsEvent` and navigation messages to perform advanced PVT (Position, Velocity, Time) calculations and constellation management.
2.  **Data Normalization**: Converting disparate inputs (Fused results, `Location` objects, and custom `Coordinates`) into a unified `LocationResult` format for consumption by the [Path Tracking System (PTService)](02_path_tracking_system__ptservice__.md).
3.  **Correction Integration**: Orchestrating the application of DGNSS or SBAS corrections to raw GNSS measurements.
4.  **Centroid Calculation**: Implementing a sampling-based centroid algorithm for improved stability in high-precision modes.

## Architecture and Data Flow

The subsystem operates as a hierarchy of managers, each acting as a specialized provider. These managers feed into "Source" abstractions (`FLLocationSource`, `LMLocationSource`, `GNSSLocationSource`), which act as observers/listeners to the higher-level services.

### Data Flow Hierarchy
1.  **Hardware/API Layer**: Android System Services (Fused Location, `LocationManager`, GNSS Measurements).
2.  **Management Layer**: `FLManager`, `LMManager`, and `GNSSManager` process raw events.
3.  **Abstraction Layer**: The "Source" objects (`FLLocationSource`, etc.) wrap the managers.
4.  **Consumer Layer**: `PTService` (for path recording) and `EKF Engine` (for advanced filtering).

```mermaid
graph TD
    subgraph "Tier 1: Fused"
        FL[FLManager] --> FL_Src[FLLocationSource]
    end

    subragd "Tier 2: Standard GPS"
        LM[LMManager] --> LM_Src[LMLocationSource]
        LM --> INAV[InavMessage/NMEA Parsing]
    end

    subgraph "Tier 3: High-Precision GNSS"
        GNSS[GNSSManager] --> G_Src[GNSSLocationSource]
        GNSS --> PVT[PVT Engine / Constellations]
        GNSS --> CORR[Corrections: DGNSS/SBAS]
    end

    FL_Src --> PT[PTService]
    LM_Src --> PT
    G_Src --> PT
    G_Src -.-> EKF[EKF Engine]
```

## Implementation Details

### Tier 1: Fused Location (`FLManager`)
This layer uses the `FusedLocationProviderClient` to request updates. It is the primary source for standard, low-power tracking.
*   **File**: `app/src/main/java/com/erasmicoin/euspa/gsa/egnss4all/model/fusedLocation/FLManager.java`
*   **Key Functionality**: Manages `LocationRequest` intervals and priority. It provides a mechanism to automatically move the map camera via `requestCameraMoveToNewLocation`.

### Tier 2: Standard Provider & NMEA (`LMManager`)
This layer interacts directly with `android.location.LocationManager` using the `GPS_PROVIDER`.
*   **File**: `app/src/main/java/com/erasmicoin/euspa/gsa/egnss4all/model/locationManager/LMManager.java`
*   **NMEA/Inav Processing**: It implements a callback for `GnssNavigationMessage.TYPE_GAL_I`. It extracts raw bytes, encodes them as Base64, and stores them in an `InavMessage` object to facilitate the processing of Galileo-specific navigation data.

### Tier 3: High-Precision GNSS (`GNSSManager`)
The most complex layer, responsible for heavy computational tasks involving raw GNSS measurements.
*   **File**: `app/src/main/java/com/erasmicoin/euspa/gsa/egnss4all/model/GNSSLocation/GNSSManager.java`
*   **Measurement Processing**: It listens to `GnssMeasurementsEvent`. If the system is initialized, it utilizes a `PvtMethod` and `Constellation` object to calculate an advanced pose (`rawPose`) based on satellite visibility and signal strength.
*   **Correction Handling**: Dynamically loads `DGNSSCorrection` or `SBASCorrection` based on user settings stored in `GNSSSettingsStore`.
*   **Centroid Logic**: When "Position Centroid" is enabled, the manager collects a series of coordinates into `campionamentiX/Y` arrays. Once the sample threshold is met, it uses a `GrahamScan` algorithm to compute the convex hull and find the centroid of the trajectory points.

```java
// Example: High-Precision Centroid Calculation Logic in GNSSManager.java
if (numCampionamenti == GNSSSettingsStore.readPositionCentroidSamples(appContext)) {
    numCampionamenti = 0; // Reset counter
    double[] copyOfX = Arrays.copyOfRange(campionamentiX, 0, campionamentiX.length);
    double[] copyOfY = Arrays.copyOfRange(campionamentiY, 0, campionamentiY.length);
    
    // Compute the geometric center of the sampled points
    List<Point> convex = GrahamScan.getConvexHull(copyOfX, copyOfY);
    centroid = GrahamScan.getHullCentroid(convex);

    Location myLocation = new Location(MainService.GNSS_PROVIDER);
    myLocation.setLatitude(centroid.x);
    myLocation.setLongitude(centroid.y);
    // ... finalize location result
}
```

## Current Behavior and Constraints

*   **Multi-Source Availability**: The system can simultaneously run `FLManager`, `LMManager`, and `GNSSManager` updates, providing redundancy.
*   **OSNMA Validation**: For Galileo constellations, the `GNSSManager` triggers an asynchronous `ServerPostPacketTask` via a dedicated thread to validate navigation messages against a remote server for authenticity.
*   **Constraints**:
    *   Highly dependent on `ACCESS_FINE_LOCATION` permissions; failure to acquire these prevents all tiers from functioning.
    *   The High-Precision tier requires significant computational overhead and is subject to the constraints of the selected `PvtMethod`.

## Known Gaps

*   **Manual Source Switching**: While the managers are implemented, the logic for a seamless "hot-swap" (e.g., automatically downgrading from GNSS to Fused when signal is lost) is not fully automated and relies on external service orchestration.
*   **Centroid Memory Management**: The `campionamenti` arrays in `GNSSManager` are fixed-size based on settings, which may lead to overflows if the configuration is updated dynamically during a session.

## Future Requirements

*   **Unified Stream API**: Refactoring all managers to implement a common interface to simplify the "Tiered" switching logic within `PTService`.
*   **Enhanced Error Recovery**: Implementing an automatic fallback mechanism where the failure of the High-Precision tier triggers an immediate request for Fused Location updates.

## Related Specifications

*   [Path Tracking System (PTService)](02_path_tracking_system__ptservice__.md)
*   [EKF (Extended Kalman Filter) Engine](04_ekf__extended_kalman_filter__engine_.md)
*   [Persistence Layer (Room Database)](05_persistence_layer__room_database__.md)
