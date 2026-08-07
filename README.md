# FlowMetrics

**Own your energy data.**

FlowMetrics is a self-hosted energy historian for home batteries and solar systems. It records normalized battery, solar, grid, and load telemetry in PostgreSQL, then turns it into day, week, month, year, and lifetime analytics without hiding gaps or inventing measurements.

The first production connector target is EcoFlow. The included deterministic demo connector drives the same ingestion, event, aggregation, API, and UI pipeline.

## What it shows

- live solar, grid, battery, load, SOC, and device health;
- gap-aware solar, grid, charge, discharge, and output energy;
- peak power, min/max SOC, active durations, sessions, and equivalent cycles;
- power and SOC curves with bounded history responses;
- solar, grid-import, battery, offline, and telemetry-gap events;
- daily records, input energy mix, explicit coverage, and CSV export;
- permanent local PostgreSQL history and documented backup/restore.

## Quick start

```bash
cp .env.example .env
# Set a strong POSTGRES_PASSWORD and update DATABASE_URL to match.
docker compose up -d
```

Open `http://localhost:3000`. The default demo mode begins recording a reproducible home-energy profile immediately. Create the local administrator when prompted by a client using `/api/v1/auth/setup`; the current visual dashboard is also suitable as a read-only product preview.

Only two services run: `flowmetrics` and `postgres`. Data persists in `flowmetrics_data` and `postgres_data` volumes. The image runs as a non-root user and targets Linux amd64 and arm64.

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build:docker
```

The production Docker build compiles the Vite/React interface and bundles the Fastify service. Apache ECharts renders the detailed daily curve.

## Calculations and trust

Power is integrated with the trapezoidal rule. Adjacent samples farther apart than the configured gap limit are never bridged. All timestamps are stored as `TIMESTAMPTZ`; device timezones define local days. Zero grid input is called “no import,” never a grid outage. Input mix is solar vs grid input energy, not household self-sufficiency.

See [calculations](docs/calculations.md), [data model](docs/data-model.md), and [architecture](docs/architecture.md).

## EcoFlow status

No EcoFlow endpoint, header, signature, MQTT topic, or payload field is guessed. The connector boundary and encrypted configuration storage exist, but live EcoFlow transport is intentionally disabled until current official documentation and authorized fixture payloads can be verified. See [EcoFlow support](docs/ecoflow.md).

## Backup

```bash
scripts/backup.sh
FLOWMETRICS_CONFIRM_RESTORE=YES_REPLACE_DATABASE scripts/restore.sh backup.dump
```

Restore is destructive. Read [backup and restore](docs/backup-restore.md) first.

## Privacy and security

FlowMetrics is local-first. Connector secrets are AES-256-GCM encrypted outside PostgreSQL, sessions are HttpOnly/SameSite, logs redact credential fields, and raw vendor payload storage is disabled by default. `AUTH_MODE=none` is available only for deliberately trusted networks.

MIT licensed. Contributions are welcome.
