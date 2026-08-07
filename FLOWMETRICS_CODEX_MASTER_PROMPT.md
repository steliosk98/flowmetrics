# FlowMetrics — Codex Master Build Prompt

Paste the prompt below into Codex from a directory where you want it to create the new project.

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
