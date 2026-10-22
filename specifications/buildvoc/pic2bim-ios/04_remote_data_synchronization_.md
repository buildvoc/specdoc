# Remote Data Synchronization

While the [Native-to-Web Data Bridge](03_native_to_web_data_bridge_.md) facilitates the transfer of local parameters from the iOS environment, the **Remote Data Synchronization** subsystem is responsible for the asynchronous retrieval of real-time satellite ephemeris data from an external network resource.

## Purpose and Responsibility

The primary responsibility of this subsystem is to interface with a remote REST API to fetch current satellite positions (azimuth and elevation) based on the user's geographic coordinates. It acts as the primary data acquisition layer for the [SkyView Plotting Engine](01_skyview_plotting_engine_.md), providing the dynamic orbital information required to render an accurate skyplot.

## Architecture and Data Flow

The subsystem operates within the JavaScript execution context of the WebKit view, utilizing the `axios` library to perform asynchronous HTTP operations.

### Data Flow Diagram

```mermaid
graph TD
    A[updateGraph Trigger] -->|Input: lat, lon, type| B[Axios HTTP POST]
    B -->|Request Payload| C[Remote API: getSatellates]
    C -->|JSON Response: satname -> {azimuth, elevation}| D[Promise Resolution]
    D -->|Iterate & Transform| E[Plotly Data Array Construction]
    E -->|Update Trace| F[SkyView Plotting Engine]
```

### Interface Definition

The subsystem communicates via a standardized RESTful interface:

* **Endpoint:** `http://18.119.99.44/getSatellites`
* **HTTP Method:** `POST`
* **Request Payload (JSON):**
    | Parameter | Type | Description |
    | :--- | :--- | :--- |
    | `lat` | Float | Latitude of the observer |
    | `lon` | Float | Longitude of the observer |
    | `type` | String | Constellation identifier (e.g., "GPS") |

* **Response Format (JSON):** An object where each key is a satellite identifier (`satname`) and the value contains orbital coordinates:
    ```json
    {
      "G01": { "azimuth": "45.2", "elevation": "30.5" },
      "G02": { "azimuth": "120.0", "elevation": "15.2" }
    }
    ```

## Implementation Details

The implementation is contained within the `updateGraph` function in `EGNSS4ALL/SkyView/orbit.js`.

### Asynchronous Request Handling

The subsystem utilizes a Promise-based approach to handle the network lifecycle. Upon a successful response, the logic iterates through the returned JSON object to reconstruct the satellite traces for the rendering engine.

```javascript
// EGNSS4．SkyView/orbit.js

updateGraph = function(_lat, _lon, constType) {
    // Execute asynchronous POST request
    axios.post('http://18.119.99.44/getSatellites', { 
        lat: _lat,
        lon: _lon,
        type: constType
    }).then((response) => {
        // Access the deserialized JSON payload
        remoteJsonData = response.data;

        let dataArray = [];
        
        // Map remote satellite objects to Plotly-compatible traces
        for (let satname in remoteJsonData) {
            let satObj = remoteJsonData[satname];
            let dataObj = {
                type: "scatterpolargl",
                r: [parseFloat(satObj.elevation).toFixed(1)], // Radial mapping
                theta: [parseFloat(satObj.azimuth).toFixed(1)], // Angular mapping
                name: satname,
                // ... marker configuration
            };
            dataArray.push(dataObj);
        }

        // Trigger re-render of the Plotly engine
        Plotly.newPlot('skymap', dataArray, layout, { ... });
    }).catch((e) => {
        // Basic error reporting
        alert("Error downloading skyplot data");
    });
}
```

### Dependencies and Constraints

* **Library Dependency:** Requires `axios` for handling the HTTP/1.1 protocol and Promise management.
* **Network Dependency:** The subsystem is entirely dependent on the availability of the remote server at `18.119.99.44`.
* **Data Transformation:** The system assumes that the incoming numeric strings from the API can be safely parsed via `parseFloat()`.

## Current Behavior and Constraints

* **Hardcoded Configuration:** The API endpoint URL is hardcoded within the logic, preventing runtime environment switching.
* **Synchronous Error Handling:** Errors are handled via a blocking browser `alert()`, which disrupts the user experience in the WebKit view.
* **Single Request Pattern:** The system currently performs a single request per function call; it does not implement an autonomous polling or heartbeat mechanism.

## Known Gaps

* **Lack of Configuration Abstraction:** The endpoint URL and request parameters are not managed by the [Application Configuration](05_application_configuration_.md) subsystem.
* **No Retry Logic:** If a network timeout occurs, the system fails immediately without attempting to re-establish the connection.
* **Payload Sensitivity:** There is no validation of the `response.data` structure; malformed JSON from the server will cause runtime exceptions during the iteration loop.

## Future Requirements

* **Dynamic Endpoint Management:** Integrate with [Application Configuration](05_application_configuration_.md) to allow dynamic switching between production and staging API environments.
* **Polling Mechanism:** Implement a configurable interval-based timer to automate periodic data synchronization without manual triggers from the native layer.
* **Robust Error Recovery:** Implement exponential backoff retry strategies for handling transient network failures.

## Related Specifications

* [SkyView Plotting Engine](01_skyview_plotting_engine_.md)
* [GNSS Constellation Logic](02_gnss_constellation_logic_.md)
* [Native-to-Web Data Bridge](03_native_to_web_data_bridge_.md)
* [Application Configuration](05_application_configuration_.md)
