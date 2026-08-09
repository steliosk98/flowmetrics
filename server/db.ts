import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import type { NormalizedTelemetry } from "../packages/core/index";

/**
 * Return `date` columns as plain `YYYY-MM-DD` strings.
 *
 * By default node-postgres builds a JS Date at *the server's* local midnight,
 * which serialises to an instant. A browser in another timezone then parses that
 * back to the previous or next calendar day, so `local_date` would silently
 * disagree with the day it describes. A calendar date has no time zone; keeping
 * it a string keeps it that way.
 */
pg.types.setTypeParser(1082, value => value);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(910_240_117)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(row => row.version));
    for (const filename of (await readdir(resolve("migrations"))).filter(name => name.endsWith(".sql")).sort()) {
      const version = filename.replace(/\.sql$/, "");
      if (!applied.has(version)) await client.query(await readFile(resolve("migrations", filename), "utf8"));
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(910_240_117)").catch(() => undefined);
    client.release();
  }
}

export interface DeviceRegistration {
  connectorType: string;
  connectorName: string;
  vendor: string;
  vendorDeviceId: string;
  model: string;
  name: string;
  capacityWh?: number;
}

/** Upserts the connector row and its device, returning the internal device id. */
export async function ensureDevice(registration: DeviceRegistration) {
  const connector = await pool.query<{ id: string }>(`INSERT INTO connectors (connector_type,name) VALUES ($1,$2) ON CONFLICT (connector_type,name) DO UPDATE SET updated_at=now() RETURNING id`, [registration.connectorType, registration.connectorName]);
  const connectorId = connector.rows[0]?.id ?? (await pool.query<{ id: string }>("SELECT id FROM connectors WHERE connector_type=$1 ORDER BY created_at LIMIT 1", [registration.connectorType])).rows[0].id;
  // capacity_wh has a CHECK (> 0), so an unknown capacity must stay NULL rather than 0.
  const capacityWh = registration.capacityWh && registration.capacityWh > 0 ? registration.capacityWh : null;
  const device = await pool.query<{ id: string }>(`INSERT INTO devices (connector_id,vendor,vendor_device_id,serial_number,model,name,capacity_wh,timezone) VALUES ($1,$2,$3,$3,$4,$5,$6,$7) ON CONFLICT (connector_id,vendor_device_id) DO UPDATE SET model=EXCLUDED.model,name=EXCLUDED.name,capacity_wh=COALESCE(EXCLUDED.capacity_wh,devices.capacity_wh),updated_at=now() RETURNING id`, [connectorId, registration.vendor, registration.vendorDeviceId, registration.model, registration.name, capacityWh, process.env.TZ ?? "UTC"]);
  return device.rows[0].id;
}

export async function ensureDemoDevice() {
  return ensureDevice({ connectorType: "demo", connectorName: "Deterministic demo", vendor: "demo", vendorDeviceId: "demo-delta-2-max", model: "Delta 2 Max", name: "Delta 2 Max", capacityWh: 2048 });
}

export async function persistTelemetry(deviceId: string, sample: NormalizedTelemetry) {
  await pool.query(`INSERT INTO telemetry_samples (device_id,observed_at,received_at,battery_soc_pct,battery_power_w,battery_charge_power_w,battery_discharge_power_w,solar_input_w,solar_input_1_w,solar_input_2_w,grid_input_w,grid_voltage_v,grid_frequency_hz,grid_connected,ac_output_w,dc_output_w,total_output_w,battery_temperature_c,inverter_temperature_c,battery_soh_pct,cycle_count,device_online,quality_flags,raw_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT (device_id,observed_at) DO NOTHING`, [deviceId,sample.observedAt,sample.receivedAt,sample.batterySocPct,sample.batteryPowerW,sample.batteryChargePowerW,sample.batteryDischargePowerW,sample.solarInputW,sample.solarInput1W,sample.solarInput2W,sample.gridInputW,sample.gridVoltageV,sample.gridFrequencyHz,sample.gridConnected,sample.acOutputW,sample.dcOutputW,sample.totalOutputW,sample.batteryTemperatureC,sample.inverterTemperatureC,sample.batterySohPct,sample.cycleCount,sample.deviceOnline,sample.qualityFlags,process.env.STORE_RAW_PAYLOADS === "true" ? sample.raw : null]);
  await pool.query("UPDATE devices SET last_seen_at=$2,updated_at=now() WHERE id=$1", [deviceId, sample.observedAt]);
}
