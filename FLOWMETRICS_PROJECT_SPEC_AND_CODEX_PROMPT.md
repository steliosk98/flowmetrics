# FlowMetrics
## Product Specification, Architecture, Implementation Plan, and Codex Master Build Prompt

**Working project name:** FlowMetrics  
**Repository name:** `flowmetrics`  
**Tagline:** **Own your energy data.**  
**Product description:** A self-hosted, Docker-first historical analytics platform for home batteries, solar generation, and grid usage. Start with EcoFlow, but design the core so other vendors can be added later without rewriting the application.

> This document is intended to be both the authoritative project specification and the master prompt that can be given to Codex to build the project from scratch.

---

# 1. Product vision

FlowMetrics should give owners of EcoFlow batteries a permanent, beautiful, self-hosted history of what their energy system has done.

The core problem is simple:

- Battery apps often emphasize the current state rather than long-term analysis.
- Historical data may be limited, difficult to export, or tied to a vendor cloud.
- Users want to answer questions such as:
  - How much solar energy did I collect today?
  - How much grid energy did I import today?
  - At what times did grid import begin and end?
  - How much energy did the battery discharge today?
  - What was my peak solar production?
  - What was my peak load?
  - How did today compare with yesterday?
  - How much solar did I generate this week, month, or year?
  - What percentage of incoming energy came from solar versus the grid?
  - How many hours was the battery charging or discharging?
  - What was the lowest battery state of charge overnight?
  - How many equivalent battery cycles have occurred over time?
  - When did the device go offline?
  - What happened during a particular day?

FlowMetrics should continuously collect telemetry, retain it locally, calculate trustworthy energy aggregates, detect important events, and present the results through an elegant custom web interface.

The user should own the data.

The application should not require Grafana, Home Assistant, InfluxDB, ClickHouse, Kafka, Redis, or any other specialist infrastructure.

The default installation experience should be:

```bash
git clone https://github.com/<owner>/flowmetrics.git
cd flowmetrics
cp .env.example .env
docker compose up -d
```

Then:

```text
http://localhost:3000
```

A future packaged release may reduce this further so a user can run only `docker compose up -d`.

---

# 2. Product positioning

FlowMetrics is **not** intended to be:

- another Grafana dashboard;
- another Home Assistant dashboard;
- an EcoFlow clone;
- an energy automation engine;
- an AI energy optimizer;
- a complex enterprise telemetry stack;
- a proprietary cloud service;
- a controller that changes battery settings without explicit user intent.

FlowMetrics **is** intended to be:

- self-hosted;
- local-first for storage;
- easy to deploy with Docker;
- visually polished;
- focused on historical energy analytics;
- resilient to restarts and temporary network/API outages;
- explicit about data quality and derived metrics;
- friendly to Raspberry Pi, NAS, mini-PC, Linux server, Docker Desktop, and home-lab users;
- EcoFlow-first in v1;
- vendor-neutral internally.

The product should feel closer to a purpose-built consumer energy application than an infrastructure monitoring dashboard.

A useful positioning sentence for the README:

> **FlowMetrics is a self-hosted energy historian for home batteries and solar systems. Connect your battery, keep your telemetry forever, and explore beautiful day, week, month, year, and lifetime analytics.**

---

# 3. Key principles

## 3.1 One-command deployment

The application must be straightforward for a normal Docker user.

The default stack should contain only two runtime services:

1. `flowmetrics`
2. `postgres`

Do not add Redis, Kafka, RabbitMQ, ClickHouse, InfluxDB, Grafana, Elasticsearch, or Prometheus to the required stack.

Optional integrations may be added later, but they must not be required for a standard installation.

---

## 3.2 PostgreSQL as the database

Use standard PostgreSQL.

Reasons:

- established and extremely mature;
- broadly understood;
- excellent official Docker support;
- portable;
- simple backup and restore;
- suitable for millions of telemetry rows per device per year;
- supports indexes, JSONB, window functions, materialized logic, native partitioning if ever needed, and robust transactions;
- easy for contributors to run locally.

Use a maintained major PostgreSQL release and pin the Docker Compose image to a major version, e.g.:

```yaml
image: postgres:18
```

Do not use TimescaleDB as a hard dependency. If support is ever added, it should be optional.

---

## 3.3 Purpose-built UI

Do not use Grafana as the product UI.

Build a custom responsive web application.

Recommended stack:

- React
- TypeScript
- Vite
- Apache ECharts for charting
- a clean component system with accessible primitives
- Fastify for the backend/API
- TypeScript end-to-end
- PostgreSQL through a lightweight typed database layer

The application should be built into a single production application image. The Fastify server should serve the built React assets as well as the JSON API.

---

## 3.4 Two containers, not a microservice zoo

The production architecture should initially be:

```text
                  Browser
                     |
                     v
        +---------------------------+
        |      FlowMetrics App      |
        |                           |
        | React frontend            |
        | Fastify API               |
        | EcoFlow connector         |
        | Collector                 |
        | Aggregator                |
        | Event detector            |
        | Scheduler                 |
        +-------------+-------------+
                      |
                      v
               +-------------+
               | PostgreSQL  |
               +-------------+
```

All application responsibilities may be separated into modules internally, but they should run in one application container for v1.

This keeps installation and maintenance simple.

---

## 3.5 Vendor-neutral core

EcoFlow is the first connector, but the normalized data model must not contain EcoFlow-specific names.

The application should be structured roughly as:

```text
src/
  connectors/
    types/
    ecoflow/
    mock/
  collector/
  normalization/
  analytics/
  events/
  db/
  api/
  scheduler/
  security/
web/
```

Future connectors should be able to add:

```text
connectors/bluetti/
connectors/anker/
connectors/victron/
connectors/jackery/
```

without changing the core analytics model.

---

# 4. EcoFlow integration

EcoFlow currently provides an official IoT Developer Platform that allows developers to access their own device operation rights and data. Use the **official EcoFlow developer interface** as the primary cloud connector.

Official reference:

- https://developer.ecoflow.com/
- https://developer.ecoflow.com/us/document/introduction

## Critical implementation rule

**Do not invent EcoFlow API endpoints, authentication headers, field names, MQTT topics, payload formats, or device capabilities.**

Before implementing the production EcoFlow connector:

1. Read the current official EcoFlow developer documentation.
2. Verify the current authentication mechanism.
3. Verify the device discovery/listing mechanism.
4. Verify whether telemetry is obtained through polling, MQTT/subscription, or both.
5. Verify API rate limits.
6. Verify model-specific telemetry payloads.
7. Map actual EcoFlow values into the normalized FlowMetrics telemetry model.
8. Preserve unknown/raw values without corrupting normalized fields.
9. Document which EcoFlow models and fields are confirmed supported.

If access to live documentation is unavailable while coding, implement:

- the full connector interface;
- a production-ready mock connector;
- fixture-driven EcoFlow payload parsers based only on verified samples;
- explicit TODOs for unverified external calls.

Never guess an external API contract merely to make tests pass.

## Connector responsibilities

Each connector should expose a common interface similar to:

```ts
interface EnergyConnector {
  id: string;
  vendor: string;

  validateConfiguration(config: ConnectorConfig): Promise<ValidationResult>;
  discoverDevices(): Promise<DiscoveredDevice[]>;
  start(onTelemetry: TelemetryHandler): Promise<void>;
  stop(): Promise<void>;
  getHealth(): ConnectorHealth;
}
```

A connector may internally use a subscription, MQTT client, polling loop, or a hybrid approach.

The rest of FlowMetrics must not care how telemetry arrived.

---

# 5. Normalized telemetry model

Every connector should normalize vendor data into a common sample.

The model should support values such as:

```ts
type NormalizedTelemetry = {
  observedAt: Date;
  receivedAt: Date;
  deviceId: string;

  batterySocPct?: number;
  batteryPowerW?: number;
  batteryChargePowerW?: number;
  batteryDischargePowerW?: number;

  solarInputW?: number;
  solarInput1W?: number;
  solarInput2W?: number;

  gridInputW?: number;
  gridVoltageV?: number;
  gridFrequencyHz?: number;
  gridConnected?: boolean;

  acOutputW?: number;
  dcOutputW?: number;
  totalOutputW?: number;

  batteryTemperatureC?: number;
  inverterTemperatureC?: number;

  batterySohPct?: number;
  cycleCount?: number;

  deviceOnline?: boolean;

  raw?: Record<string, unknown>;
};
```

Not every device will support every field.

All normalized measurements must therefore be nullable/optional.

## Sign conventions

Do not let vendor-specific positive/negative conventions leak into the database.

Normalize into explicit concepts wherever possible:

- `battery_charge_power_w >= 0`
- `battery_discharge_power_w >= 0`
- `solar_input_w >= 0`
- `grid_input_w >= 0`
- `total_output_w >= 0`

If a vendor exposes a signed `battery_power`, normalize it into charge/discharge fields with clear, tested rules.

Retaining a signed `battery_power_w` may still be useful for charting, but its sign convention must be defined globally and documented.

Suggested global convention if retained:

- positive = battery discharging;
- negative = battery charging.

---

# 6. Database design

Use migrations from day one.

Do not rely on an ORM auto-sync feature in production.

A lightweight typed SQL layer is preferred. Drizzle, Kysely, or direct `pg` are acceptable if migrations are explicit, reviewable, and deterministic.

## 6.1 `devices`

Suggested columns:

```text
id UUID PRIMARY KEY
connector_id TEXT NOT NULL
vendor TEXT NOT NULL
vendor_device_id TEXT NOT NULL
serial_number TEXT
model TEXT
name TEXT NOT NULL
capacity_wh DOUBLE PRECISION
timezone TEXT NOT NULL
enabled BOOLEAN NOT NULL DEFAULT TRUE
metadata JSONB NOT NULL DEFAULT '{}'
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
last_seen_at TIMESTAMPTZ
```

Unique constraint:

```text
(connector_id, vendor_device_id)
```

---

## 6.2 `connectors`

Suggested columns:

```text
id UUID PRIMARY KEY
connector_type TEXT NOT NULL
name TEXT NOT NULL
enabled BOOLEAN NOT NULL DEFAULT TRUE
encrypted_config BYTEA / TEXT
config_version INTEGER NOT NULL
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
last_connected_at TIMESTAMPTZ
last_error_at TIMESTAMPTZ
last_error TEXT
```

Secrets must not be logged.

See the security section for encryption.

---

## 6.3 `telemetry_samples`

This is the raw normalized historian table.

Suggested columns:

```text
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
device_id UUID NOT NULL REFERENCES devices(id)
observed_at TIMESTAMPTZ NOT NULL
received_at TIMESTAMPTZ NOT NULL

battery_soc_pct DOUBLE PRECISION
battery_power_w DOUBLE PRECISION
battery_charge_power_w DOUBLE PRECISION
battery_discharge_power_w DOUBLE PRECISION

solar_input_w DOUBLE PRECISION
solar_input_1_w DOUBLE PRECISION
solar_input_2_w DOUBLE PRECISION

grid_input_w DOUBLE PRECISION
grid_voltage_v DOUBLE PRECISION
grid_frequency_hz DOUBLE PRECISION
grid_connected BOOLEAN

ac_output_w DOUBLE PRECISION
dc_output_w DOUBLE PRECISION
total_output_w DOUBLE PRECISION

battery_temperature_c DOUBLE PRECISION
inverter_temperature_c DOUBLE PRECISION

battery_soh_pct DOUBLE PRECISION
cycle_count INTEGER
device_online BOOLEAN

quality_flags INTEGER NOT NULL DEFAULT 0
raw_payload JSONB
```

Recommended indexes:

```text
BTREE (device_id, observed_at DESC)
BRIN (observed_at)
```

Potential dedupe constraint, if the connector provides enough uniqueness:

```text
UNIQUE (device_id, observed_at)
```

Do not blindly enforce this if legitimate multiple samples can have the same timestamp. Implement a tested deduplication strategy.

### Raw payload policy

Raw vendor payload storage should be configurable.

Default:

```text
STORE_RAW_PAYLOADS=false
```

Raw payloads are useful for debugging connector mappings but may greatly increase storage.

---

## 6.4 `energy_hourly`

Purpose: efficient day/week/month queries while preserving accurate integration results.

Suggested columns:

```text
device_id UUID NOT NULL
bucket_start TIMESTAMPTZ NOT NULL

solar_energy_wh DOUBLE PRECISION NOT NULL DEFAULT 0
grid_energy_wh DOUBLE PRECISION NOT NULL DEFAULT 0
battery_charge_wh DOUBLE PRECISION NOT NULL DEFAULT 0
battery_discharge_wh DOUBLE PRECISION NOT NULL DEFAULT 0
ac_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0
dc_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0
total_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0

peak_solar_w DOUBLE PRECISION
peak_grid_w DOUBLE PRECISION
peak_output_w DOUBLE PRECISION

min_soc_pct DOUBLE PRECISION
max_soc_pct DOUBLE PRECISION
avg_soc_pct DOUBLE PRECISION

solar_active_seconds BIGINT NOT NULL DEFAULT 0
grid_import_seconds BIGINT NOT NULL DEFAULT 0
battery_charging_seconds BIGINT NOT NULL DEFAULT 0
battery_discharging_seconds BIGINT NOT NULL DEFAULT 0

sample_count BIGINT NOT NULL DEFAULT 0
valid_integration_seconds BIGINT NOT NULL DEFAULT 0
gap_seconds BIGINT NOT NULL DEFAULT 0

updated_at TIMESTAMPTZ NOT NULL

PRIMARY KEY (device_id, bucket_start)
```

---

## 6.5 `energy_daily`

Suggested columns:

```text
device_id UUID NOT NULL
local_date DATE NOT NULL
timezone TEXT NOT NULL

solar_energy_wh DOUBLE PRECISION NOT NULL DEFAULT 0
grid_energy_wh DOUBLE PRECISION NOT NULL DEFAULT 0
battery_charge_wh DOUBLE PRECISION NOT NULL DEFAULT 0
battery_discharge_wh DOUBLE PRECISION NOT NULL DEFAULT 0
ac_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0
dc_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0
total_output_wh DOUBLE PRECISION NOT NULL DEFAULT 0

peak_solar_w DOUBLE PRECISION
peak_solar_at TIMESTAMPTZ
peak_grid_w DOUBLE PRECISION
peak_grid_at TIMESTAMPTZ
peak_output_w DOUBLE PRECISION
peak_output_at TIMESTAMPTZ

min_soc_pct DOUBLE PRECISION
min_soc_at TIMESTAMPTZ
max_soc_pct DOUBLE PRECISION
max_soc_at TIMESTAMPTZ

solar_active_seconds BIGINT NOT NULL DEFAULT 0
grid_import_seconds BIGINT NOT NULL DEFAULT 0
battery_charging_seconds BIGINT NOT NULL DEFAULT 0
battery_discharging_seconds BIGINT NOT NULL DEFAULT 0

equivalent_cycle_fraction DOUBLE PRECISION

sample_count BIGINT NOT NULL DEFAULT 0
valid_integration_seconds BIGINT NOT NULL DEFAULT 0
gap_seconds BIGINT NOT NULL DEFAULT 0
coverage_pct DOUBLE PRECISION

updated_at TIMESTAMPTZ NOT NULL

PRIMARY KEY (device_id, local_date)
```

Weekly, monthly, yearly, and lifetime summaries should initially be calculated from `energy_daily`.

Do not create unnecessary weekly/monthly/yearly storage tables until profiling shows a need.

---

## 6.6 `device_events`

Suggested columns:

```text
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
device_id UUID NOT NULL
event_type TEXT NOT NULL
started_at TIMESTAMPTZ NOT NULL
ended_at TIMESTAMPTZ
duration_seconds BIGINT
severity TEXT NOT NULL DEFAULT 'info'
value_start DOUBLE PRECISION
value_end DOUBLE PRECISION
metadata JSONB NOT NULL DEFAULT '{}'
created_at TIMESTAMPTZ NOT NULL
```

Possible event types:

```text
SOLAR_STARTED
SOLAR_STOPPED

GRID_IMPORT_STARTED
GRID_IMPORT_STOPPED

GRID_CONNECTED
GRID_DISCONNECTED

BATTERY_CHARGE_STARTED
BATTERY_CHARGE_STOPPED

BATTERY_DISCHARGE_STARTED
BATTERY_DISCHARGE_STOPPED

BATTERY_FULL
BATTERY_LOW

DEVICE_ONLINE
DEVICE_OFFLINE

TELEMETRY_GAP_STARTED
TELEMETRY_GAP_ENDED
```

Important semantic distinction:

If the hardware/API does **not** expose whether mains/grid is physically connected, FlowMetrics must **not** claim `GRID_CONNECTED`.

If only `grid_input_w` is known, detect:

```text
GRID_IMPORT_STARTED
GRID_IMPORT_STOPPED
```

This avoids presenting an inference as a measured fact.

---

## 6.7 `app_settings`

Suggested key/value storage for non-secret settings:

```text
key TEXT PRIMARY KEY
value JSONB NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

Examples:

- default timezone;
- default device;
- chart preferences;
- event thresholds;
- retention settings;
- data collection settings.

---

## 6.8 `aggregation_state`

Track exactly how far background processing has progressed.

Suggested fields:

```text
device_id UUID PRIMARY KEY
last_integrated_sample_id BIGINT
last_integrated_at TIMESTAMPTZ
last_event_sample_id BIGINT
last_event_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

This makes restarts deterministic and avoids double-counting.

---

# 7. Accurate energy calculation

This is one of the most important parts of the entire project.

Power is an instantaneous measurement in watts.

Energy is the integral of power over time.

Use numerical integration rather than simply summing samples.

For consecutive points:

```text
P0 at T0
P1 at T1
```

Use trapezoidal integration:

```text
average_power_w = (P0 + P1) / 2

delta_hours = (T1 - T0) / 3600

energy_wh = average_power_w * delta_hours
```

Do this independently for:

- solar input;
- grid input;
- battery charge;
- battery discharge;
- AC output;
- DC output;
- total output.

## 7.1 Data gaps

Do not integrate blindly across large gaps.

Example:

```text
12:00:00  500 W
12:00:10  510 W
12:45:00  520 W
```

It would be misleading to assume the device remained near 515 W for 45 minutes.

Create a configurable maximum integration gap.

Suggested logic:

```text
max_gap = max(3 * expected_sample_interval, 120 seconds)
```

or a similarly conservative documented rule.

If a gap exceeds the limit:

- do not integrate across the missing interval;
- record the gap;
- reduce data coverage;
- optionally create a telemetry-gap event.

Daily summaries should expose:

```text
coverage_pct
gap_seconds
```

The UI should display a small warning when data coverage is incomplete.

Example:

> Data coverage: 92.4% — totals may be understated because telemetry was unavailable for 1h 49m.

This feature materially improves the honesty and quality of the project.

---

## 7.2 Out-of-order telemetry

The ingestion layer must handle:

- duplicate messages;
- out-of-order timestamps;
- reconnect bursts;
- delayed cloud messages;
- process restarts.

Do not assume events always arrive in strict timestamp order.

Store `observed_at` and `received_at` separately.

Aggregation should operate by observed time.

---

## 7.3 Time zones and daylight saving

The database should store timestamps as UTC using `TIMESTAMPTZ`.

Each device has an IANA timezone such as:

```text
Europe/Nicosia
Europe/London
America/New_York
Australia/Sydney
```

A "day" must be calculated in the device's configured local timezone.

Never define a daily bucket as simply UTC midnight unless the device timezone is UTC.

Daylight saving transitions must be covered by automated tests.

---

# 8. Derived analytics

FlowMetrics should calculate useful metrics while carefully distinguishing **measured** values from **estimated/derived** values.

## 8.1 Measured/strongly-derived metrics

Examples:

- solar energy received;
- grid energy imported;
- battery charge energy;
- battery discharge energy;
- output energy;
- peak solar power;
- peak grid input;
- peak load;
- minimum battery SOC;
- maximum battery SOC;
- solar-active duration;
- grid-import duration;
- battery charging duration;
- battery discharging duration;
- number of grid-import sessions;
- longest grid-import session;
- number of charging sessions;
- equivalent battery cycles;
- telemetry coverage.

---

## 8.2 Equivalent battery cycles

If usable device capacity is known:

```text
equivalent_cycle_fraction =
  (battery_charge_wh + battery_discharge_wh)
  / (2 * usable_capacity_wh)
```

Alternatively, use only discharge throughput if that is the documented methodology.

Pick one definition, document it clearly, and use it consistently.

Do not label this as the vendor's official cycle count.

Label it:

> Estimated equivalent full cycles

If EcoFlow itself exposes a cycle count, show both:

```text
Device-reported cycles
Estimated equivalent cycles
```

---

## 8.3 Solar/grid input share

A safe metric:

```text
solar_input_share =
  solar_energy_wh
  / (solar_energy_wh + grid_energy_wh)
```

and:

```text
grid_input_share =
  grid_energy_wh
  / (solar_energy_wh + grid_energy_wh)
```

Label these as **input energy mix**.

Do not automatically call them "home self-sufficiency" because grid energy may be charging the battery and the application may not know the true origin of energy discharged later.

If a future connector provides enough metering to calculate true self-consumption or self-sufficiency, add those metrics with explicit definitions.

---

## 8.4 Comparison metrics

For day/week/month/year views provide:

- current period;
- previous equivalent period;
- absolute difference;
- percentage change where mathematically valid.

Examples:

```text
Solar today: 8.42 kWh
+18% vs yesterday
```

```text
Grid this month: 61.2 kWh
-23% vs previous month
```

Avoid misleading percentages when the previous value is zero.

---

# 9. Event detection

Events make the project more useful than a collection of line charts.

Implement an event state machine with configurable thresholds and debounce windows.

Suggested default behavior, subject to tuning:

## Solar

Start:

```text
solar_input_w >= 10 W for 30-60 seconds
```

Stop:

```text
solar_input_w < 10 W for 60-120 seconds
```

## Grid import

Start:

```text
grid_input_w >= 20 W for 20-30 seconds
```

Stop:

```text
grid_input_w < 20 W for 30-60 seconds
```

## Battery charging

Start:

```text
battery_charge_power_w >= 20 W
```

## Battery discharging

Start:

```text
battery_discharge_power_w >= 20 W
```

## Battery full

Example:

```text
battery_soc_pct >= 99.5 for >= 120 seconds
```

Do not repeatedly emit the same event while the state remains active.

## Device offline

Use connector health and expected reporting frequency.

Example:

```text
no valid telemetry for max(3 * expected interval, 180 seconds)
```

Make thresholds configurable.

Use hysteresis/debounce to prevent rapid event flapping.

---

# 10. User interface

The UI is a core differentiator and must receive significant attention.

Requirements:

- polished;
- fast;
- responsive;
- excellent in light and dark mode;
- desktop-first but fully usable on tablet/mobile;
- no generic admin-dashboard aesthetic;
- large, readable energy values;
- charts with smooth hover behavior;
- clear units everywhere;
- accessible keyboard/focus states;
- sensible empty/loading/error states;
- time ranges easy to navigate.

Do not use excessive gradients, neon styling, or gimmicks.

The visual language should feel calm and energy-focused.

---

# 11. Navigation

Suggested top-level sections:

```text
Overview
History
Events
Devices
Data
Settings
About
```

The user should be able to switch devices globally.

---

# 12. Overview page

The overview page should answer:

> What is happening now, and what happened today?

Top status area:

```text
Device name
Model
Online/offline state
Last update age
Battery SOC
Current solar input
Current grid input
Current battery charge/discharge
Current load
```

## Today metric cards

Examples:

```text
Solar generated
Grid imported
Output energy
Battery charged
Battery discharged
Peak solar
Peak load
Lowest SOC
Input energy mix
Data coverage
```

Example visual concept:

```text
+------------------------------------------------------------+
| FlowMetrics                         DELTA Pro 3        LIVE |
|                                                            |
| Today   Week   Month   Year   All                           |
+------------------------------------------------------------+
| SOLAR           GRID            OUTPUT          BATTERY     |
| 8.42 kWh        2.13 kWh        9.37 kWh        73%         |
| +18%            -23%            +4%             charging    |
+------------------------------------------------------------+
```

---

# 13. Main daily power chart

Build a multi-series time chart.

Potential series:

- Solar input
- Grid input
- Battery charge
- Battery discharge
- AC output
- DC output
- Total output

Requirements:

- series toggles;
- hover tooltip showing exact timestamp/value;
- zoom or range selection;
- sensible downsampling for large date ranges;
- preserve spikes where possible;
- display watts/kilowatts intelligently;
- vertical markers for important events where useful.

Do not fetch millions of raw rows into the browser.

The API must provide appropriately bucketed/resampled series based on requested range and display width.

Example API behavior:

```text
24 hours -> 1 minute buckets
7 days   -> 5 or 15 minute buckets
30 days  -> hourly buckets
1 year   -> daily energy aggregates
all      -> daily/monthly aggregates
```

Exact policies should be centralized and documented.

---

# 14. Battery SOC chart

Show battery state of charge as a separate chart.

Features:

- 0–100% scale;
- min/max markers;
- charge/discharge period shading if tasteful;
- event markers;
- hover timestamp/value;
- comparison with previous period optional later.

Important events may appear on the timeline:

```text
Solar started
Grid import started
Battery full
Solar stopped
Grid import stopped
```

---

# 15. Energy timeline

This should be a signature feature.

For one selected day show a chronological story:

```text
00:00  Battery discharging
03:42  Grid import started
05:17  Battery charging from available inputs
06:38  Solar production started
10:14  Battery reached full state
17:46  Battery discharge started
19:18  Solar production stopped
22:14  Grid import started
```

The UI may combine:

- a horizontal day timeline;
- colored/labelled intervals;
- a chronological event list.

Do not claim energy routing that is not actually measured.

For example, do not write "solar -> house + battery" unless data supports that path.

---

# 16. Grid usage analytics

Show:

- grid energy imported today;
- grid-import sessions;
- total import duration;
- longest import session;
- peak grid input;
- first import time;
- last import time.

Visual timeline example:

```text
00:00 |-----████---------██████------| 24:00
           04:10       16:42
```

If actual connection state is known independently of import, show both:

- Grid connected
- Grid importing

Otherwise only show grid import.

---

# 17. Solar analytics

Daily solar view should include:

- total solar energy;
- solar power curve;
- peak solar power;
- time of peak;
- first meaningful production;
- last meaningful production;
- production duration;
- average power while producing;
- comparison with previous day.

Week/month/year views should show:

- daily solar kWh bars;
- rolling average;
- best day;
- worst complete-data day;
- total solar;
- average daily solar.

Optional future functionality:

- weather correlation;
- forecast versus actual;
- PV efficiency modeling.

These are not v1 requirements.

---

# 18. History page

Provide range presets:

```text
Today
Yesterday
7D
30D
This Month
Previous Month
This Year
Previous Year
All
Custom
```

The UI should adapt based on range.

## Day view

- detailed power curves;
- SOC curve;
- event timeline;
- energy totals.

## Week view

- daily bars for solar/grid/output;
- SOC min/max summaries;
- grid-session totals;
- daily table.

## Month view

- daily solar/grid/output;
- totals;
- averages;
- best/worst days;
- cumulative energy chart optional.

## Year view

- monthly aggregates;
- year-to-date totals;
- comparison to previous year if available.

## All-time view

- lifetime energy totals;
- annual/monthly trend;
- estimated equivalent cycles;
- first recorded date;
- total samples;
- data coverage.

---

# 19. Data table

Include a useful daily summary table.

Columns might include:

```text
Date
Solar kWh
Grid kWh
Output kWh
Battery charged kWh
Battery discharged kWh
Peak solar W
Peak output W
Min SOC
Grid duration
Solar duration
Coverage
```

Features:

- sorting;
- pagination;
- CSV export;
- click row -> open that day.

---

# 20. Events page

Allow filtering by:

- device;
- event type;
- date range;
- severity.

Example:

```text
2026-08-07 22:14  Grid import started
2026-08-07 19:18  Solar production stopped
2026-08-07 17:46  Battery discharge started
2026-08-07 10:14  Battery reached full
2026-08-07 06:38  Solar production started
```

Clicking an event should navigate to or open the relevant time in the history chart.

---

# 21. Devices page

For each device show:

- display name;
- vendor;
- model;
- serial number if available;
- connector;
- online state;
- last seen;
- configured capacity;
- timezone;
- enabled state.

Device settings:

- rename;
- timezone;
- usable capacity;
- event thresholds;
- data collection settings where connector supports them;
- remove/disable device.

Never delete historical data automatically when a device is removed.

Require explicit separate confirmation for destructive historical deletion.

---

# 22. Setup/onboarding

On first launch, show an onboarding wizard.

Suggested flow:

## Step 1 — Welcome

```text
Welcome to FlowMetrics
Own your energy data.
```

## Step 2 — Create local admin account

Recommended default for security.

Fields:

```text
Username
Password
Confirm password
```

Allow an explicit `AUTH_MODE=none` environment setting for trusted home-lab deployments.

## Step 3 — Timezone

Auto-suggest from browser, but require an explicit stored IANA timezone.

## Step 4 — Add connector

Initial option:

```text
EcoFlow
Demo / Mock
```

## Step 5 — EcoFlow credentials

Use the current credential fields required by the official EcoFlow developer platform.

Do not hardcode names until verified from current documentation.

## Step 6 — Discover devices

List discovered devices and let user select which to monitor.

## Step 7 — Finish

Start collection and show the dashboard.

---

# 23. Demo mode

Demo mode is important for GitHub adoption.

A new user should be able to see the product without owning an EcoFlow device.

Provide a deterministic mock connector that generates a realistic 24-hour home-energy profile including:

- overnight battery discharge;
- sunrise;
- increasing solar;
- midday solar peak;
- battery charging;
- battery reaching full;
- evening solar decline;
- evening discharge;
- one or more grid-import periods;
- realistic SOC movement;
- optional short telemetry gap.

Demo data should be reproducible from a seed.

Add:

```env
DEMO_MODE=true
```

or allow selection during onboarding.

Demo mode should exercise the exact same ingestion, aggregation, events, API, and charts as a real connector.

Do not implement a fake dashboard path that bypasses core logic.

---

# 24. Security

## 24.1 Secrets

Connector credentials must never appear:

- in logs;
- in API responses;
- in frontend source;
- in browser local storage;
- in error traces exposed to the user;
- in Git history.

## 24.2 Credential encryption

If connector credentials are stored in PostgreSQL, encrypt them at application level.

Suggested approach:

- AES-256-GCM or another modern authenticated encryption mechanism;
- application master key;
- auto-generate a master key on first startup and store it in an application data volume with restrictive permissions;
- permit `APP_ENCRYPTION_KEY` through environment for advanced deployments;
- never store the master key in the database.

Example volumes:

```text
postgres_data
flowmetrics_data
```

`flowmetrics_data` may contain the generated encryption key and non-database instance state.

Document that database backups containing encrypted connector settings require the master key to restore those settings.

Alternatively, allow users to keep credentials only in environment variables.

## 24.3 Authentication

Implement simple single-instance local authentication.

Preferred:

- local admin user;
- Argon2id password hashing;
- secure HttpOnly session cookie;
- SameSite protection;
- CSRF protection for state-changing routes where appropriate;
- rate limiting on login;
- logout;
- session expiry.

Allow:

```env
AUTH_MODE=none
```

for users who deliberately want an unauthenticated trusted-network deployment.

Warn clearly in documentation that disabling authentication means anyone able to reach the service may view the energy data and change settings.

## 24.4 Network

The application must not require inbound internet exposure.

Default use case is LAN/self-hosting.

No telemetry or analytics data should be sent to FlowMetrics developers.

No third-party analytics/tracking by default.

---

# 25. Data export and ownership

A major product message is:

> Your data is yours.

The Data page should show:

```text
First recording
Latest recording
Telemetry sample count
Approximate database size
Historical coverage
Raw payload retention setting
```

Exports:

- daily summary CSV;
- hourly summary CSV;
- raw telemetry CSV for selected range;
- JSON export;
- events CSV/JSON.

Large exports must stream rather than load the entire dataset into RAM.

---

# 26. Backup and restore

Document simple command-line backup:

```bash
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > flowmetrics-backup.sql
```

Create an easier helper script if useful:

```bash
./scripts/backup.sh
```

Also implement a web UI backup download if it can be done safely.

The production application image may include the PostgreSQL client required to stream a dump.

Restore must require explicit confirmation because it is destructive.

At minimum provide a documented:

```bash
./scripts/restore.sh <backup>
```

A future UI restore flow is acceptable, but not at the expense of core reliability.

---

# 27. API design

Use a versioned API:

```text
/api/v1/
```

Suggested routes:

```text
GET  /api/v1/health
GET  /api/v1/status

GET  /api/v1/devices
GET  /api/v1/devices/:id
PATCH /api/v1/devices/:id

GET  /api/v1/live/:deviceId

GET  /api/v1/history/power
GET  /api/v1/history/soc
GET  /api/v1/history/energy

GET  /api/v1/summary/day
GET  /api/v1/summary/range

GET  /api/v1/events

GET  /api/v1/data/stats
GET  /api/v1/export/daily.csv
GET  /api/v1/export/hourly.csv
GET  /api/v1/export/telemetry.csv
GET  /api/v1/export/events.csv

GET  /api/v1/connectors
POST /api/v1/connectors
POST /api/v1/connectors/:id/test
POST /api/v1/connectors/:id/discover
PATCH /api/v1/connectors/:id

GET  /api/v1/settings
PATCH /api/v1/settings
```

Use runtime validation for all request/query/body data, e.g. Zod.

Return explicit units.

Example:

```json
{
  "solarEnergyWh": 8420.4,
  "gridEnergyWh": 2131.1,
  "coveragePct": 99.8
}
```

Keep canonical backend units:

- power = W
- energy = Wh
- temperature = °C
- time = UTC timestamps
- percentage = 0–100

The frontend may display kW/kWh dynamically.

---

# 28. Chart query strategy

Never send an unbounded raw time series to the browser.

Implement range-aware server aggregation.

Possible policy:

```text
<= 48 hours    -> 1-minute average/min/max buckets
<= 14 days     -> 5-minute or 15-minute buckets
<= 90 days     -> hourly buckets
<= 2 years     -> daily energy buckets
> 2 years      -> monthly aggregation from daily data
```

For power charts, preserving peaks matters.

A response bucket can include:

```text
avg
min
max
last
```

The UI may use average for the line and min/max where useful.

Set a target upper bound such as 2,000-5,000 points per series.

---

# 29. Live updates

The current-state dashboard should update without full page refreshes.

Acceptable v1 approach:

- backend maintains latest known state;
- browser polls a lightweight endpoint every 5-10 seconds.

Preferred if straightforward:

- Server-Sent Events (SSE).

Do not add WebSocket infrastructure unless there is a concrete need.

Live update transport should not affect historical ingestion.

---

# 30. Docker deployment

## 30.1 `docker-compose.yml`

Production-oriented example structure:

```yaml
services:
  flowmetrics:
    image: ghcr.io/<owner>/flowmetrics:latest
    build:
      context: .
    restart: unless-stopped
    ports:
      - "${FLOWMETRICS_PORT:-3000}:3000"
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      TZ: ${TZ:-UTC}
      AUTH_MODE: ${AUTH_MODE:-local}
    volumes:
      - flowmetrics_data:/app/data
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:18
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
  flowmetrics_data:
```

Do not hardcode insecure default production passwords.

Provide a first-run helper or clear `.env.example`.

## 30.2 Multi-stage image

Build:

1. dependency stage;
2. frontend build;
3. backend build;
4. minimal production runtime.

Run the application as a non-root user.

Add a health endpoint and Docker health check.

## 30.3 Supported architectures

GitHub Container Registry release images must target at least:

```text
linux/amd64
linux/arm64
```

This is important for:

- Raspberry Pi 4/5 64-bit;
- NAS devices;
- mini PCs;
- common Linux servers.

---

# 31. Environment configuration

Create `.env.example`.

Possible variables:

```env
# Web
FLOWMETRICS_PORT=3000
TZ=UTC
AUTH_MODE=local

# Database
POSTGRES_DB=flowmetrics
POSTGRES_USER=flowmetrics
POSTGRES_PASSWORD=CHANGE_ME

# Optional externally managed encryption key.
# If unset, FlowMetrics generates and persists a key in flowmetrics_data.
APP_ENCRYPTION_KEY=

# Telemetry
STORE_RAW_PAYLOADS=false

# Demo
DEMO_MODE=false

# Logging
LOG_LEVEL=info
```

Do not put EcoFlow production credentials in `.env.example`.

If the EcoFlow connector supports environment credentials, name them only after checking official documentation and document both setup options.

---

# 32. Logging

Use structured logs.

Include:

- timestamp;
- log level;
- component;
- device ID where relevant;
- connector ID where relevant.

Do not include:

- access keys;
- secret keys;
- passwords;
- authorization headers;
- raw credential-bearing request/response payloads.

Provide useful messages for:

- connector established;
- connector disconnected;
- device discovered;
- ingestion started;
- aggregation caught up;
- data gap detected;
- migration applied;
- graceful shutdown.

---

# 33. Reliability

The application must:

- recover from PostgreSQL being temporarily unavailable;
- reconnect to EcoFlow after network failure;
- not double-count energy after restart;
- not duplicate events after restart;
- gracefully stop connectors on SIGTERM;
- finish or safely checkpoint in-flight writes;
- run migrations exactly once using a migration lock;
- perform exponential backoff on external failures;
- avoid tight retry loops.

Database writes should use sensible batches where beneficial.

---

# 34. Data retention

Default:

```text
Retention: Forever
```

Users want historical ownership.

Later optional retention settings may include:

- keep raw telemetry forever;
- retain raw telemetry for N months while keeping hourly/daily aggregates forever;
- disable raw vendor payload storage.

Never silently delete data.

---

# 35. PostgreSQL scaling strategy

Do not prematurely add specialist time-series infrastructure.

At a 10-second interval:

```text
8,640 samples/day
~3.15 million samples/year/device
```

At a 5-second interval:

```text
17,280 samples/day
~6.31 million samples/year/device
```

This is a reasonable workload for PostgreSQL when queries use proper indexes and historical views use aggregate tables.

Initial strategy:

- BTREE `(device_id, observed_at)`;
- BRIN timestamp index;
- hourly and daily aggregates;
- range-aware API downsampling;
- periodic `ANALYZE` handled by PostgreSQL autovacuum.

Native monthly partitioning may be added later if profiling demonstrates a need.

Do not add partition complexity solely because the table is time-series data.

---

# 36. Testing strategy

Testing is mandatory.

## 36.1 Unit tests

Cover:

- telemetry normalization;
- sign conventions;
- trapezoidal integration;
- integration gap handling;
- event debounce;
- event state transitions;
- cycle estimates;
- period comparisons;
- timezone conversion;
- unit formatting.

## 36.2 Database integration tests

Run against real PostgreSQL in CI.

Cover:

- migrations;
- ingestion;
- deduplication;
- aggregate rebuilds;
- restart/checkpoint behavior;
- export queries;
- indexes where practical.

## 36.3 Connector contract tests

Every connector must pass common tests.

The mock connector is the reference implementation.

## 36.4 EcoFlow parser fixtures

Store sanitized fixture payloads for every confirmed supported model/message type.

Never store real credentials or personally identifying data.

## 36.5 Frontend tests

Cover important interactions:

- date range switching;
- device switching;
- legend toggles;
- empty states;
- incomplete-data warnings;
- event navigation;
- onboarding.

## 36.6 End-to-end tests

Use Playwright for critical flows:

- first-run demo onboarding;
- dashboard loads;
- history range changes;
- events visible;
- CSV export works.

## 36.7 Timezone tests

Explicitly test DST boundaries.

Examples:

- Europe/London spring forward/fall back;
- America/New_York;
- a no-DST timezone.

Daily totals must group according to the configured local day.

---

# 37. Development experience

Suggested commands:

```bash
npm install
npm run dev
npm run test
npm run test:integration
npm run test:e2e
npm run lint
npm run typecheck
npm run build
docker compose up --build
```

Prefer a workspace layout if it makes separation cleaner:

```text
apps/
  server/
  web/

packages/
  core/
  db/
  connectors/
```

Do not create package fragmentation without purpose.

A single root lockfile is required.

---

# 38. Repository structure

A possible target:

```text
flowmetrics/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── docker.yml
│   │   └── release.yml
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── core/
│   ├── db/
│   └── connectors/
├── migrations/
├── scripts/
│   ├── backup.sh
│   ├── restore.sh
│   └── demo-data.*
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── ecoflow.md
│   ├── calculations.md
│   ├── backup-restore.md
│   └── troubleshooting.md
├── .dockerignore
├── .editorconfig
├── .env.example
├── .gitignore
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── Dockerfile
├── LICENSE
├── README.md
├── SECURITY.md
├── docker-compose.yml
├── package.json
└── lockfile
```

Adjust if the chosen TypeScript tooling has a cleaner structure.

---

# 39. GitHub quality

The repository should look professional from the first public release.

Include:

- strong README;
- architecture diagram;
- screenshots or generated demo screenshots;
- feature list;
- quick start;
- Docker Compose instructions;
- EcoFlow developer setup guide;
- supported devices table;
- data ownership statement;
- backup instructions;
- troubleshooting;
- contribution guide;
- security policy;
- MIT license;
- issue templates;
- PR template;
- automated CI badges once workflows exist.

Suggested GitHub topics:

```text
ecoflow
solar
battery
energy
energy-monitoring
self-hosted
docker
postgresql
raspberry-pi
home-energy
power-station
typescript
react
```

---

# 40. README opening

Suggested copy:

```markdown
# FlowMetrics

**Own your energy data.**

FlowMetrics is a self-hosted energy historian for home batteries and solar systems.
It continuously records battery, solar, grid, and load telemetry and turns it into
beautiful day, week, month, year, and lifetime analytics.

Start with EcoFlow. Keep the data yourself.

## What can FlowMetrics show?

- Solar generated today, this week, month, year, and all time
- Grid energy imported and exactly when import occurred
- Battery charge/discharge history
- Battery state-of-charge curves
- Peak solar and load
- Solar and grid input energy mix
- Grid-import sessions and durations
- Charging and discharging sessions
- Estimated equivalent battery cycles
- Data coverage and telemetry gaps
- CSV/JSON export
- Permanent local history
```

---

# 41. MVP acceptance criteria

Version `0.1.0` is complete when all of the following are true.

## Deployment

- `docker compose up -d` starts the stack.
- Only the FlowMetrics application and PostgreSQL are required.
- Data survives container recreation.
- Images work on amd64 and arm64.
- Health checks work.

## Setup

- User can create a local instance/admin.
- User can set timezone.
- User can use demo mode.
- User can configure an EcoFlow connector using verified official API details.
- Supported devices can be discovered and selected.

## Collection

- Telemetry continuously enters PostgreSQL.
- Restarts do not cause duplicate energy counting.
- Missing data creates coverage gaps.
- Device online/offline health is visible.

## Analytics

- Daily solar Wh/kWh works.
- Daily grid Wh/kWh works.
- Daily output energy works.
- Daily battery charge/discharge energy works.
- Peak values work.
- Min/max SOC works.
- Hourly and daily aggregates work.
- Day/week/month/year/all-time APIs work.
- Equivalent cycle estimate works if capacity is known.
- Data coverage is calculated.

## Events

- solar start/stop;
- grid import start/stop;
- charging start/stop;
- discharging start/stop;
- battery full;
- device offline/online;
- telemetry gaps.

## UI

- responsive overview;
- live status;
- today metrics;
- power chart;
- SOC chart;
- daily event timeline;
- week/month/year history;
- daily summary table;
- events page;
- device page;
- data/export page;
- settings;
- dark/light mode.

## Export

- daily CSV;
- raw telemetry CSV for a chosen range;
- events CSV;
- documented backup/restore.

## Quality

- unit tests;
- DB integration tests;
- Playwright smoke tests;
- CI;
- lint;
- typecheck;
- production build;
- no secrets in repo;
- README and docs.

---

# 42. Features intentionally deferred beyond v0.1

Keep these out of the critical path unless the core is already finished and stable:

- battery control commands;
- automatic charge/discharge optimization;
- electricity tariff optimization;
- solar forecasting;
- weather correlation;
- AI recommendations;
- Home Assistant add-on packaging;
- mobile native applications;
- multi-user/RBAC;
- cloud-hosted service;
- Prometheus exporter;
- notifications;
- Bluetti/Anker/Victron/Jackery connectors;
- plugin marketplace.

The architecture should allow these later, but v0.1 should remain focused.

---

# 43. v0.2+ roadmap ideas

Possible later milestones:

## v0.2

- notification rules;
- ntfy/Telegram/Discord/email;
- better outage analytics;
- comparison overlays;
- installation update checker;
- improved backup UI.

## v0.3

- second battery vendor connector;
- connector SDK/documentation;
- Home Assistant integration or add-on;
- import historical vendor data where available.

## v0.4

- weather + solar forecast;
- forecast-vs-actual;
- cost/tariff analytics;
- grid cost calculations.

## v1.0

- multiple mature connectors;
- stable connector API;
- polished migration and backup story;
- strong documentation;
- proven multi-year database performance.

---

# 44. Product design details

## Units

Display dynamically:

- `<1000 W` -> W
- `>=1000 W` -> kW
- `<1000 Wh` where appropriate -> Wh
- `>=1000 Wh` -> kWh
- large lifetime energy -> MWh when useful

Do not mix Wh and kWh silently in chart series.

## Rounding

Examples:

```text
843 W
1.42 kW
8.42 kWh
73%
42.3 °C
3h 18m
```

Store full numeric precision; format only for display.

## Colors

Choose semantic chart colors and support both themes.

Maintain consistent meaning across the product:

- solar;
- grid;
- battery;
- load/output.

Do not rely on color alone; use labels and line styles/legends.

## Loading states

Prefer skeletons or subtle placeholders.

## Empty states

Example:

> No solar production was recorded during this period.

## Incomplete data

Example:

> 91.7% data coverage. Energy totals may be lower than actual values because telemetry was unavailable for 1h 59m.

---

# 45. Performance targets

Reasonable v0.1 targets on a small home server:

- dashboard API response generally <500 ms for aggregated periods;
- initial dashboard useful content <2 seconds on a LAN after warm startup;
- historical chart responses bounded to a few thousand points;
- ingestion should remain stable with at least several devices at 5-second telemetry;
- database should remain usable after tens of millions of samples;
- UI should not render tens of thousands of DOM/SVG points unnecessarily.

Profile before adding infrastructure.

---

# 46. Observability for FlowMetrics itself

Keep this simple.

Endpoints:

```text
/api/v1/health
/api/v1/status
```

Health should include safe summaries:

- application healthy;
- database reachable;
- migrations current;
- collector status;
- last telemetry age.

Do not expose credentials.

Optional future Prometheus metrics may be added, but not required.

---

# 47. Data-quality philosophy

FlowMetrics must prefer being transparent over looking perfect.

If telemetry is missing, show it.

If a metric is estimated, label it.

If a hardware capability is not known, do not infer it as fact.

If an API does not expose grid connection state, do not call lack of grid input an outage.

If a battery's usable capacity is unknown, do not invent equivalent cycle counts.

Every calculation in the UI should have a tooltip or documentation entry explaining its definition.

Add a `/docs/calculations.md` file.

---

# 48. Git workflow for Codex

Codex must create and maintain the Git repository as it builds.

## Repository creation

Preferred repository name:

```text
flowmetrics
```

Before creating it:

```bash
gh auth status
```

If GitHub CLI authentication is unavailable, this is a genuine blocker for the user's requirement to push continuously. Stop before coding and tell the user exactly what authentication command is needed.

If authenticated:

1. determine the authenticated GitHub username;
2. check whether `<username>/flowmetrics` already exists;
3. if it does not exist, use `flowmetrics`;
4. if it exists and is unrelated, use `flowmetrics-energy`;
5. create the local project directory;
6. initialize Git;
7. create the GitHub repository as **public**;
8. set `origin`;
9. push the first bootstrap commit immediately.

Do not create the project inside another unrelated Git repository.

## Branch policy during initial autonomous build

For the initial build:

```text
main
```

may be used directly so Codex can continuously push progress.

Once the project is usable, add branch-protection recommendations to documentation.

## Commit style

Use Conventional Commits.

Examples:

```text
chore: bootstrap repository
feat(db): add telemetry and aggregate schema
feat(connectors): add deterministic mock energy connector
feat(analytics): add gap-aware energy integration
feat(events): detect solar and grid import sessions
feat(ui): add daily energy dashboard
test: add timezone and integration coverage
docs: add EcoFlow setup guide
```

Never make one giant final commit.

Push after each meaningful, green milestone.

Do not push failing code unless a commit is explicitly labelled as an incomplete work-in-progress and there is no safer alternative.

---

# 49. Suggested Codex commit/push checkpoints

## Checkpoint 1 — Repository bootstrap

Create:

- README skeleton;
- license;
- `.gitignore`;
- `.editorconfig`;
- package/tooling skeleton;
- initial Docker files;
- CI placeholder.

Run basic validation.

Commit:

```text
chore: bootstrap FlowMetrics repository
```

Push.

---

## Checkpoint 2 — Application skeleton

Create:

- TypeScript workspace;
- Fastify server;
- React/Vite frontend;
- static frontend serving;
- health endpoint;
- logging;
- basic tests.

Commit:

```text
feat: add application and web foundations
```

Push.

---

## Checkpoint 3 — PostgreSQL and migrations

Create:

- Compose database;
- database connection;
- migrations;
- devices;
- connectors;
- telemetry;
- aggregates;
- events;
- settings/state.

Run migrations and integration tests.

Commit:

```text
feat(db): add PostgreSQL historian schema
```

Push.

---

## Checkpoint 4 — Mock connector

Create a deterministic mock energy source.

Requirements:

- realistic solar curve;
- realistic load;
- SOC changes;
- grid import sessions;
- stable seed;
- reconnect behavior.

Commit:

```text
feat(connectors): add deterministic demo energy connector
```

Push.

---

## Checkpoint 5 — Ingestion and normalization

Implement:

- connector lifecycle;
- normalized telemetry;
- validation;
- batching/dedupe;
- restart safety;
- latest state.

Commit:

```text
feat(collector): persist normalized telemetry safely
```

Push.

---

## Checkpoint 6 — Energy integration

Implement:

- trapezoidal integration;
- gap detection;
- hourly aggregates;
- daily aggregates;
- coverage;
- rebuild command.

Tests must cover irregular intervals and gaps.

Commit:

```text
feat(analytics): add gap-aware energy aggregation
```

Push.

---

## Checkpoint 7 — Event engine

Implement:

- state machine;
- debounce;
- solar sessions;
- grid-import sessions;
- charge/discharge sessions;
- full/low SOC;
- online/offline;
- gap events.

Commit:

```text
feat(events): add energy event detection engine
```

Push.

---

## Checkpoint 8 — Historical API

Implement versioned endpoints for:

- current state;
- history;
- summary;
- events;
- daily table;
- range aggregation.

Commit:

```text
feat(api): expose live and historical energy analytics
```

Push.

---

## Checkpoint 9 — Dashboard UI

Implement:

- navigation;
- device selector;
- period selector;
- metric cards;
- live state;
- daily power chart;
- SOC chart;
- responsive theme.

Commit:

```text
feat(ui): add polished energy overview dashboard
```

Push.

---

## Checkpoint 10 — History and event UX

Implement:

- week/month/year/all;
- daily energy bars;
- summary tables;
- event timeline;
- event filters;
- incomplete coverage warnings.

Commit:

```text
feat(ui): add historical analytics and event timeline
```

Push.

---

## Checkpoint 11 — Setup and security

Implement:

- onboarding;
- local authentication;
- encrypted connector config;
- timezone/device setup;
- secure sessions;
- connector configuration UI.

Commit:

```text
feat(security): add secure onboarding and connector credentials
```

Push.

---

## Checkpoint 12 — EcoFlow connector

Only after verifying official current documentation.

Implement:

- auth;
- device discovery;
- connection;
- telemetry mapping;
- reconnect/backoff;
- sanitized fixtures;
- supported capability documentation.

Commit:

```text
feat(ecoflow): add official EcoFlow telemetry connector
```

Push.

If device-specific mappings require real hardware verification, document exactly what is verified versus unverified.

---

## Checkpoint 13 — Export/backup

Implement:

- streaming CSV;
- JSON where useful;
- database stats;
- backup script;
- restore script;
- docs.

Commit:

```text
feat(data): add exports and backup tooling
```

Push.

---

## Checkpoint 14 — Production Docker and CI

Implement:

- multi-stage Docker image;
- non-root runtime;
- health checks;
- amd64/arm64 Buildx;
- GHCR publish workflow;
- CI test matrix;
- dependency caching.

Commit:

```text
ci: add multi-architecture container publishing
```

Push.

---

## Checkpoint 15 — Documentation and v0.1 release prep

Complete:

- README;
- screenshots using demo data;
- architecture docs;
- calculations docs;
- setup guide;
- EcoFlow guide;
- support matrix;
- backup guide;
- troubleshooting;
- CONTRIBUTING;
- SECURITY;
- issue templates.

Run full test suite and Compose smoke test.

Commit:

```text
docs: prepare FlowMetrics v0.1 release
```

Push.

Tag only when all MVP acceptance criteria pass:

```text
v0.1.0
```

---

# 50. GitHub Actions

## CI workflow

On PR and push:

1. install dependencies;
2. lint;
3. typecheck;
4. unit tests;
5. PostgreSQL integration tests;
6. frontend tests;
7. build;
8. optional Compose smoke test.

## Docker workflow

On:

- main;
- version tags.

Build with Docker Buildx for:

```text
linux/amd64
linux/arm64
```

Push to:

```text
ghcr.io/<owner>/flowmetrics
```

Tags:

```text
latest
main
0.1
0.1.0
sha-<shortsha>
```

Use GitHub's standard token permissions securely.

---

# 51. Definition of done for every milestone

Before committing/pushing:

- formatter passes;
- lint passes;
- typecheck passes;
- relevant tests pass;
- no secrets detected;
- docs updated for user-visible changes;
- no TODO that hides a correctness problem;
- `git diff` reviewed;
- commit message describes the milestone.

After push:

```bash
git status
git log -1 --oneline
git remote -v
```

Confirm working tree is clean unless intentionally continuing to the next checkpoint.

---

# 52. Master Codex build prompt

Copy everything between **BEGIN CODEX PROMPT** and **END CODEX PROMPT** into Codex.

---

## BEGIN CODEX PROMPT

You are the principal engineer responsible for creating a new open-source project called **FlowMetrics** from scratch and pushing it to GitHub continuously as you build it.

Your objective is not to produce a prototype. Build a clean, maintainable, secure, Docker-first v0.1 application that satisfies the specification below.

### Mission

FlowMetrics is a self-hosted historical energy analytics platform for home batteries and solar systems.

The first supported vendor is **EcoFlow**, but all core telemetry, analytics, database, API, and UI concepts must be vendor-neutral so other connectors such as Bluetti, Anker, Victron, and Jackery can be added later.

The tagline is:

> **Own your energy data.**

The product must continuously collect telemetry, store a permanent local history, calculate energy accurately, detect meaningful events, and display elegant day/week/month/year/all-time analytics.

### Mandatory deployment philosophy

The standard installation must require only:

1. the FlowMetrics application container;
2. PostgreSQL.

Do **not** require:

- ClickHouse;
- InfluxDB;
- TimescaleDB;
- Grafana;
- Redis;
- Kafka;
- RabbitMQ;
- Elasticsearch;
- Home Assistant.

The target user should be able to clone the repository and run:

```bash
cp .env.example .env
docker compose up -d
```

and then access:

```text
http://localhost:3000
```

The project must support at least Linux `amd64` and `arm64`.

Raspberry Pi 4/5 64-bit, NAS/home-lab systems, mini PCs, standard Linux servers, and Docker Desktop are important targets.

### Mandatory database

Use standard PostgreSQL.

Use a maintained PostgreSQL major version in Compose, currently preferably:

```yaml
postgres:18
```

Use explicit SQL migrations.

Do not depend on an ORM's schema auto-sync in production.

### Recommended application stack

Use an end-to-end TypeScript stack unless you discover a strong technical reason not to:

- Node.js current LTS;
- Fastify backend;
- React;
- TypeScript;
- Vite;
- Apache ECharts;
- Zod for runtime validation;
- a lightweight typed PostgreSQL layer such as Kysely, Drizzle, or direct `pg`;
- Vitest or equivalent;
- Playwright for end-to-end tests.

The production build must result in a single FlowMetrics application image. Fastify should serve the compiled frontend.

Do not split v0.1 into separate frontend/backend/worker production containers.

### First action: GitHub and repository setup

Do this before implementing features.

1. Run:

```bash
gh auth status
```

2. If GitHub CLI is not authenticated, STOP immediately because continuous GitHub pushes are a hard requirement. Tell me exactly how to authenticate with `gh auth login`. Do not pretend you can push.

3. Determine the authenticated GitHub username.

4. Check whether `<username>/flowmetrics` exists.

5. If `flowmetrics` is available, use it.

6. If that repository already exists and is unrelated, automatically use `flowmetrics-energy` instead and make the project/package names consistent.

7. Create a NEW local project folder. Do not initialize this inside an unrelated existing repository.

8. Initialize Git.

9. Create a **public** GitHub repository using GitHub CLI.

10. Set `origin`.

11. Make a small bootstrap commit and push it immediately.

12. From that point forward, commit and push after each meaningful working milestone. Do not wait until the project is finished to push.

Use Conventional Commits.

Examples:

```text
chore: bootstrap FlowMetrics repository
feat(db): add PostgreSQL historian schema
feat(connectors): add deterministic demo connector
feat(analytics): add gap-aware energy aggregation
feat(events): detect solar and grid import sessions
feat(ui): add historical energy dashboard
```

### Work autonomously

Do not repeatedly ask me to approve ordinary engineering decisions.

When multiple reasonable implementation choices exist:

1. choose the simplest mature approach;
2. document the choice;
3. continue.

Only stop for a genuine blocker such as unavailable GitHub authentication or required external credentials that cannot be mocked.

For EcoFlow credentials, the rest of the application must still be fully buildable and testable using demo/mock mode.

### Product boundaries

FlowMetrics v0.1 is an analytics historian, not an automation controller.

Do not make battery control, tariff optimization, AI recommendations, solar forecasts, or Home Assistant packaging part of the critical path.

Focus on:

- collection;
- storage;
- aggregation;
- events;
- history;
- beautiful analytics;
- data export;
- backup;
- robust Docker deployment.

### Architecture

Use approximately:

```text
Browser
  |
  v
FlowMetrics container
  - React UI
  - Fastify API
  - connector manager
  - collector
  - normalization
  - energy aggregator
  - event detector
  - scheduler
  - auth/security
  |
  v
PostgreSQL
```

The application must contain clear internal modules, even though they run in one process/container.

Suggested source structure:

```text
apps/
  server/
  web/

packages/
  core/
  db/
  connectors/

migrations/
docs/
scripts/
```

Adjust if a simpler workspace structure is cleaner.

### Connector architecture

Create a vendor-neutral connector interface.

Conceptually:

```ts
interface EnergyConnector {
  id: string;
  vendor: string;

  validateConfiguration(config: ConnectorConfig): Promise<ValidationResult>;
  discoverDevices(): Promise<DiscoveredDevice[]>;
  start(onTelemetry: TelemetryHandler): Promise<void>;
  stop(): Promise<void>;
  getHealth(): ConnectorHealth;
}
```

Implement two connectors in v0.1:

1. deterministic mock/demo connector;
2. EcoFlow connector.

The rest of the system must not know whether telemetry came from polling, MQTT, a websocket, BLE, or another transport.

### EcoFlow rule: verify, never invent

Use EcoFlow's official developer platform as the authoritative production reference:

```text
https://developer.ecoflow.com/
https://developer.ecoflow.com/us/document/introduction
```

Before writing production EcoFlow API code, inspect the CURRENT official documentation and verify:

- authentication;
- access/secret credential mechanism;
- device listing/discovery;
- supported telemetry method;
- MQTT/subscription/polling behavior;
- rate limits;
- actual message payloads;
- model-specific fields.

DO NOT INVENT:

- endpoints;
- headers;
- signatures;
- MQTT topics;
- field names;
- capability values.

If live EcoFlow docs or credentials are unavailable, complete the connector interface, mock connector, tests, UI, DB, and analytics. Isolate any unverified EcoFlow calls behind clearly marked interfaces rather than fabricating them.

Document a support matrix showing what has actually been verified.

### Normalized telemetry

Create a normalized structure capable of representing:

```text
observed timestamp
received timestamp
device
battery SOC %
battery signed power
battery charge power W
battery discharge power W
solar input W
individual solar inputs if available
grid input W
grid voltage
grid frequency
grid connected state if truly provided
AC output W
DC output W
total output W
battery temperature
inverter temperature
battery SOH
device-reported cycle count
online status
raw vendor payload
```

All optional capabilities must remain nullable.

Normalize vendor-specific power sign conventions.

Preferred explicit model:

```text
battery_charge_power_w >= 0
battery_discharge_power_w >= 0
solar_input_w >= 0
grid_input_w >= 0
total_output_w >= 0
```

If also retaining a signed battery power value, globally define and document:

```text
positive = discharge
negative = charge
```

### Database schema

Implement explicit migrations for at least:

#### `devices`

Fields should include:

```text
UUID id
connector ID
vendor
vendor device ID
serial number
model
display name
capacity Wh
IANA timezone
enabled
metadata JSONB
created/updated timestamps
last seen timestamp
```

#### `connectors`

Fields:

```text
UUID id
connector type
name
enabled
encrypted configuration
config version
created/updated
last connected
last error
```

#### `telemetry_samples`

Use a BIGINT identity key and include:

```text
device_id
observed_at TIMESTAMPTZ
received_at TIMESTAMPTZ
battery_soc_pct
battery_power_w
battery_charge_power_w
battery_discharge_power_w
solar_input_w
solar_input_1_w
solar_input_2_w
grid_input_w
grid_voltage_v
grid_frequency_hz
grid_connected
ac_output_w
dc_output_w
total_output_w
battery_temperature_c
inverter_temperature_c
battery_soh_pct
cycle_count
device_online
quality_flags
raw_payload JSONB
```

Indexes:

```text
BTREE(device_id, observed_at DESC)
BRIN(observed_at)
```

Raw payload retention must be configurable and disabled by default.

#### `energy_hourly`

Store:

```text
device_id
bucket_start
solar_energy_wh
grid_energy_wh
battery_charge_wh
battery_discharge_wh
ac_output_wh
dc_output_wh
total_output_wh
peak values
SOC min/max/avg
solar active seconds
grid import seconds
battery charge seconds
battery discharge seconds
sample count
valid integration seconds
gap seconds
updated_at
```

Primary key:

```text
(device_id, bucket_start)
```

#### `energy_daily`

Store:

```text
device_id
local_date
timezone
solar_energy_wh
grid_energy_wh
battery_charge_wh
battery_discharge_wh
ac_output_wh
dc_output_wh
total_output_wh
peak solar + timestamp
peak grid + timestamp
peak output + timestamp
min SOC + timestamp
max SOC + timestamp
solar active seconds
grid import seconds
battery charging seconds
battery discharging seconds
estimated equivalent cycle fraction
sample count
valid integration seconds
gap seconds
coverage_pct
updated_at
```

Primary key:

```text
(device_id, local_date)
```

Compute week/month/year/all-time views from daily aggregates initially.

#### `device_events`

Include:

```text
id
device_id
event_type
started_at
ended_at
duration_seconds
severity
value_start
value_end
metadata JSONB
created_at
```

#### `app_settings`

JSONB key/value non-secret settings.

#### `aggregation_state`

Persist last processed sample/event checkpoints so restarts never double-count energy.

### Accurate energy integration

This is critical.

Use trapezoidal numerical integration.

For two adjacent samples:

```text
average_power_w = (P0 + P1) / 2
delta_hours = elapsed_seconds / 3600
energy_wh = average_power_w * delta_hours
```

Integrate separately for:

- solar;
- grid;
- battery charge;
- battery discharge;
- AC output;
- DC output;
- total output.

Do not calculate kWh by summing watts.

### Missing telemetry

Never integrate across a large data gap.

Create a documented maximum gap policy based on expected sample interval, e.g. a conservative multiple with an absolute limit.

When telemetry is absent:

- do not fabricate energy;
- record gap duration;
- reduce coverage;
- create gap event if appropriate.

The UI must say when totals may be incomplete.

Example:

```text
Data coverage: 92.4%
Totals may be understated because telemetry was unavailable for 1h 49m.
```

### Out-of-order messages

Support:

- duplicates;
- delayed samples;
- out-of-order samples;
- reconnect bursts;
- restarts.

Store both:

```text
observed_at
received_at
```

Aggregate by observed timestamp.

Build deterministic dedupe/checkpoint behavior.

### Timezones

Store timestamps in PostgreSQL as `TIMESTAMPTZ`.

Each device has an IANA timezone.

Daily boundaries must use that device timezone.

Add DST tests.

Do not assume UTC midnight is the user's day.

### Event engine

Implement debounced state-machine detection for:

```text
SOLAR_STARTED
SOLAR_STOPPED

GRID_IMPORT_STARTED
GRID_IMPORT_STOPPED

BATTERY_CHARGE_STARTED
BATTERY_CHARGE_STOPPED

BATTERY_DISCHARGE_STARTED
BATTERY_DISCHARGE_STOPPED

BATTERY_FULL
BATTERY_LOW

DEVICE_ONLINE
DEVICE_OFFLINE

TELEMETRY_GAP_STARTED
TELEMETRY_GAP_ENDED
```

Only use:

```text
GRID_CONNECTED
GRID_DISCONNECTED
```

if the connector/device genuinely exposes grid connection state.

Do not infer "grid disconnected" merely because grid input power is zero.

Use sensible configurable thresholds and hysteresis/debounce.

### Derived metrics

Implement:

- solar energy;
- grid import energy;
- battery charge energy;
- battery discharge energy;
- output energy;
- peak solar/grid/output;
- min/max SOC;
- solar active duration;
- grid import duration;
- charging/discharging duration;
- session counts;
- longest grid session;
- estimated equivalent battery cycles if capacity is configured;
- period comparisons;
- data coverage.

Implement input energy mix:

```text
solar input share =
solar Wh / (solar Wh + grid Wh)
```

and grid input share correspondingly.

Label it clearly as **input energy mix**.

Do not call it true household self-sufficiency unless the measured topology actually allows that calculation.

### Dashboard UI

The UI is a major deliverable, not an afterthought.

Build an elegant, responsive, polished custom interface.

Use Apache ECharts rather than Grafana.

Provide:

```text
Overview
History
Events
Devices
Data
Settings
About
```

Global device selector.

Global time/range selector.

Light/dark mode.

Accessible states.

#### Overview

Show current:

- online state;
- last update age;
- battery SOC;
- solar input;
- grid input;
- battery charge/discharge;
- load.

Today cards:

- solar kWh;
- grid kWh;
- output kWh;
- charged kWh;
- discharged kWh;
- peak solar;
- peak load;
- minimum SOC;
- input mix;
- coverage.

#### Daily power chart

Multi-series:

- solar;
- grid;
- battery charge;
- battery discharge;
- AC output;
- DC output;
- total output.

Features:

- legend toggles;
- detailed hover;
- zoom/range;
- sensible W/kW formatting;
- event markers;
- server-side downsampling.

#### SOC chart

0-100%.

Show min/max and useful event markers.

#### Energy timeline

Create a signature daily timeline showing measured state changes and detected events.

Example events:

```text
06:38 solar production started
10:14 battery reached full
17:46 battery discharge started
19:18 solar production stopped
22:14 grid import started
```

Never claim an unmeasured power-flow path.

#### Grid analytics

Show:

- imported energy;
- import sessions;
- total import duration;
- longest session;
- peak grid W;
- first/last import;
- horizontal session timeline.

#### Solar analytics

Show:

- total energy;
- solar curve;
- peak W/time;
- first/last meaningful production;
- active duration;
- average power while active;
- previous-period comparison.

### Historical views

Provide presets:

```text
Today
Yesterday
7D
30D
This Month
Previous Month
This Year
Previous Year
All
Custom
```

Day:

- detailed curves;
- SOC;
- event timeline;
- energy totals.

Week/month:

- daily bars;
- totals;
- daily table;
- comparisons.

Year:

- monthly aggregates;
- year-to-date;
- previous-year comparison.

All:

- lifetime totals;
- monthly/annual trend;
- equivalent cycles;
- first recording;
- sample count.

### Daily table

Columns:

```text
Date
Solar kWh
Grid kWh
Output kWh
Battery charged kWh
Battery discharged kWh
Peak solar
Peak output
Min SOC
Grid duration
Solar duration
Coverage
```

Sortable, paginated, exportable.

Clicking a day should open that day's detail.

### History API/downsampling

Never load millions of telemetry rows in a browser.

Centralize range-aware sampling.

Target <= 2,000-5,000 points per chart series.

Example:

```text
<=48h     1-minute buckets
<=14d     5/15-minute buckets
<=90d     hourly
<=2y      daily
>2y       monthly from daily
```

Power buckets should preserve average/min/max where useful so spikes are not hidden.

### Demo mode

Implement a deterministic demo/mock connector before the EcoFlow connector.

It should generate a believable daily profile:

- overnight load;
- overnight battery discharge;
- sunrise;
- rising solar;
- midday solar peak;
- battery charging;
- battery reaching full;
- evening production decline;
- evening battery discharge;
- grid import windows;
- SOC movement;
- optional telemetry gap.

Seed it so tests and screenshots are reproducible.

Demo mode must pass through the same real ingestion/analytics pipeline.

### Live updates

Use a lightweight live strategy.

SSE is preferred if clean.

Polling every 5-10 seconds is acceptable for v0.1.

Do not add unnecessary websocket infrastructure.

### Setup wizard

First-run flow:

1. Welcome.
2. Create local admin account.
3. Choose timezone.
4. Choose connector: EcoFlow or Demo.
5. Enter verified EcoFlow developer credentials if EcoFlow selected.
6. Test connector.
7. Discover devices.
8. Select devices.
9. Finish and begin collection.

### Authentication/security

Implement local instance authentication by default.

Preferred:

- Argon2id password hashes;
- HttpOnly secure session cookies;
- SameSite;
- CSRF protection as appropriate;
- login rate limiting;
- logout;
- session expiry.

Support:

```env
AUTH_MODE=none
```

for deliberately trusted LAN installs and document the risk.

### Credential encryption

Never store connector credentials plaintext in logs or APIs.

If connector credentials are persisted in PostgreSQL:

- encrypt with an authenticated encryption algorithm such as AES-256-GCM;
- use an application master key outside PostgreSQL;
- auto-generate the key in `/app/data` on first boot if no env key is supplied;
- use restrictive file permissions;
- also support `APP_ENCRYPTION_KEY`.

Create a persistent:

```text
flowmetrics_data
```

Docker volume.

Never commit secrets.

### Export

Provide streaming exports:

- daily CSV;
- hourly CSV;
- raw telemetry CSV for selected range;
- events CSV;
- JSON where useful.

The Data page must show:

- first recording;
- latest recording;
- total telemetry sample count;
- approximate DB size;
- retention;
- coverage;
- raw-payload setting.

### Backup

Add:

```text
scripts/backup.sh
scripts/restore.sh
```

using `pg_dump` / `psql` or `pg_restore`.

Document them.

If a safe web backup download is straightforward, implement it.

Restore is destructive and must require explicit confirmation/documentation.

### Docker

Create production Docker assets.

Runtime stack:

```text
flowmetrics
postgres
```

Use:

```text
restart: unless-stopped
```

PostgreSQL healthcheck.

Application healthcheck.

Persistent volumes:

```text
postgres_data
flowmetrics_data
```

Use multi-stage builds.

Run app as non-root.

Support `linux/amd64` and `linux/arm64`.

### `.env.example`

Include non-secret examples for:

```text
FLOWMETRICS_PORT
TZ
AUTH_MODE
POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD
APP_ENCRYPTION_KEY
STORE_RAW_PAYLOADS
DEMO_MODE
LOG_LEVEL
```

Do not include real EcoFlow credentials.

Do not ship a known insecure DB password as a silent production default. Provide clear setup behavior.

### Reliability

Implement:

- connector reconnect with exponential backoff;
- graceful SIGTERM;
- DB retry;
- safe aggregation checkpointing;
- no duplicate energy after restart;
- no duplicate events after restart;
- migration locking;
- bounded retries;
- structured logging.

### Logs

Structured logging only.

Never log secrets or authorization data.

Useful component tags:

```text
api
db
collector
connector:ecoflow
connector:mock
analytics
events
scheduler
auth
```

### Testing

Build comprehensive tests.

Unit:

- normalization;
- sign conventions;
- trapezoidal integration;
- irregular intervals;
- gap handling;
- event debounce;
- event state;
- cycle estimates;
- period comparisons;
- timezone handling;
- DST.

Database integration against real PostgreSQL:

- migrations;
- ingestion;
- dedupe;
- checkpoint;
- aggregate rebuild;
- exports;
- restart behavior.

Frontend:

- device/range switching;
- chart series toggles;
- empty states;
- incomplete coverage warnings;
- onboarding;
- events.

Playwright E2E:

- demo onboarding;
- dashboard;
- history;
- events;
- export.

### CI

Create GitHub Actions.

Every push/PR should run:

```text
install
format/lint check
typecheck
unit tests
Postgres integration tests
frontend tests
build
```

Add a Docker build/smoke test.

### GHCR

Create a GitHub Actions workflow using Docker Buildx.

Publish:

```text
ghcr.io/<owner>/<repo>
```

architectures:

```text
linux/amd64
linux/arm64
```

publish on main and semver tags.

### Documentation

Create:

```text
README.md
CONTRIBUTING.md
SECURITY.md
CODE_OF_CONDUCT.md
docs/architecture.md
docs/data-model.md
docs/calculations.md
docs/ecoflow.md
docs/backup-restore.md
docs/troubleshooting.md
```

Use the MIT license unless there is an existing repository constraint.

README must emphasize:

> Own your energy data.

Include:

- screenshots using demo data;
- quick start;
- features;
- architecture;
- supported platforms;
- supported EcoFlow devices/capabilities;
- data calculations;
- privacy;
- backup;
- roadmap;
- contributing.

Recommended topics:

```text
ecoflow
solar
battery
energy
energy-monitoring
self-hosted
docker
postgresql
raspberry-pi
home-energy
power-station
typescript
react
```

### Data-quality requirements

Never hide incomplete telemetry.

Daily aggregates must include coverage.

Never present an estimate as a measured value.

Never infer grid outages from zero grid power alone.

Never invent equivalent cycles if usable capacity is not configured.

Add explanations/tooltips for derived metrics.

### Performance

PostgreSQL is sufficient.

At 10-second collection:

```text
~3.15 million rows/year/device
```

At 5 seconds:

```text
~6.31 million rows/year/device
```

Use indexes and aggregates.

Do not add a specialist time-series database unless a measured benchmark proves PostgreSQL insufficient.

Do not prematurely partition the telemetry table. Add native PostgreSQL partitioning only if profiling demonstrates a real need.

### Milestone sequence and mandatory pushes

Follow these checkpoints. After each checkpoint:

1. run relevant tests;
2. run lint/typecheck;
3. review `git diff`;
4. commit with a Conventional Commit;
5. push to GitHub;
6. verify the push succeeded;
7. continue.

#### 1
Repository bootstrap.

Commit:

```text
chore: bootstrap FlowMetrics repository
```

#### 2
Fastify + React/Vite application foundations.

Commit:

```text
feat: add application and web foundations
```

#### 3
PostgreSQL + migrations + database schema.

Commit:

```text
feat(db): add PostgreSQL historian schema
```

#### 4
Deterministic mock/demo connector.

Commit:

```text
feat(connectors): add deterministic demo energy connector
```

#### 5
Normalized collector/ingestion/checkpointing.

Commit:

```text
feat(collector): persist normalized telemetry safely
```

#### 6
Gap-aware trapezoidal energy integration and hourly/daily summaries.

Commit:

```text
feat(analytics): add gap-aware energy aggregation
```

#### 7
Debounced event state machine.

Commit:

```text
feat(events): add energy event detection engine
```

#### 8
Versioned analytics/history API.

Commit:

```text
feat(api): expose live and historical energy analytics
```

#### 9
Polished overview UI, power chart, SOC chart.

Commit:

```text
feat(ui): add polished energy overview dashboard
```

#### 10
Historical views, tables, event timeline.

Commit:

```text
feat(ui): add historical analytics and event timeline
```

#### 11
Onboarding, auth, encrypted connector configuration.

Commit:

```text
feat(security): add secure onboarding and connector credentials
```

#### 12
Verified official EcoFlow connector.

Commit:

```text
feat(ecoflow): add official EcoFlow telemetry connector
```

#### 13
Streaming export and backup tooling.

Commit:

```text
feat(data): add exports and backup tooling
```

#### 14
Production Docker, multi-architecture GHCR, full CI.

Commit:

```text
ci: add multi-architecture container publishing
```

#### 15
Documentation, screenshots, final smoke tests.

Commit:

```text
docs: prepare FlowMetrics v0.1 release
```

### v0.1 acceptance checklist

Do not call the project v0.1 complete until:

- Docker Compose starts cleanly.
- Only app + PostgreSQL are required.
- Data persists.
- amd64/arm64 builds exist.
- Health checks work.
- Demo onboarding works.
- EcoFlow connector is implemented only from verified official docs.
- Telemetry persists.
- Energy aggregation is gap-aware.
- Restart does not double count.
- Solar/grid/output/battery energy works.
- Hourly/daily history works.
- Day/week/month/year/all works.
- Peak and min/max metrics work.
- Coverage works.
- Solar/grid/charge/discharge events work.
- Offline/gap events work.
- Overview is polished.
- Power chart works.
- SOC chart works.
- Event timeline works.
- Historical bars/tables work.
- exports work.
- backup/restore is documented.
- tests pass.
- CI passes.
- no secrets exist in Git history.
- documentation is complete.

### Final verification before v0.1 tag

Run the full test suite.

Build the production image.

Run a fresh install from an empty directory/volumes using documented instructions.

Use demo mode to generate data.

Verify dashboard, history, events, exports, restart persistence, and backup.

Run a basic secret scan.

Check:

```bash
git status
git log --oneline --decorate -20
git remote -v
```

Ensure all intended commits are pushed.

Only then create and push:

```text
v0.1.0
```

If GitHub Actions supports release creation, create a release from the tag.

### Engineering behavior

Keep the repository in a working state.

Do not fake successful external integrations.

Do not silently weaken tests.

Do not bypass the real analytics pipeline for demo screenshots.

Do not introduce infrastructure merely because it is fashionable.

Prefer clarity, correctness, data integrity, and easy installation.

When a task is large, implement it incrementally and push each green checkpoint.

Build FlowMetrics as if outside contributors will begin opening pull requests immediately after v0.1 is published.

## END CODEX PROMPT

---

# 53. External technical references

Use current official documentation during implementation rather than relying on this document for volatile external API details.

## EcoFlow

Official developer platform:

- https://developer.ecoflow.com/
- https://developer.ecoflow.com/us/document/introduction

## PostgreSQL Docker image

Official Docker image:

- https://hub.docker.com/_/postgres

As of August 2026, PostgreSQL 18 is available as an official multi-architecture Docker image. Pin to a maintained major version and use automated dependency updates rather than relying indefinitely on an unpinned `latest`.

---

# 54. Final product statement

FlowMetrics should eventually be describable in one sentence:

> **Install one Docker Compose stack, connect your battery, and permanently own a beautiful history of your solar, grid, battery, and energy usage.**

The first release should win users through simplicity and visual quality.

The long-term opportunity is to become a vendor-neutral, self-hosted historical analytics layer for home energy systems.
