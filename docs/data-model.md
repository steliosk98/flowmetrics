# Data model

`connectors` stores connector metadata and authenticated-encrypted configuration. `devices` maps vendor identifiers to stable local UUIDs, capacity, timezone, and capabilities. `telemetry_samples` stores nullable normalized observations and optional raw payloads. `energy_hourly` and `energy_daily` keep query-efficient aggregates. `device_events` stores debounced transitions and sessions. `aggregation_state` prevents double counting across restarts. `admin_users` and `sessions` support local instance authentication.

Battery power uses a documented global convention: positive is discharge and negative is charge. Explicit non-negative charge/discharge fields are preferred. All optional hardware capabilities remain nullable.
