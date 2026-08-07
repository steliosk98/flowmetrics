import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import type { NormalizedTelemetry } from "../packages/core/index";

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

export async function ensureDemoDevice() {
  const connector = await pool.query<{ id: string }>(`INSERT INTO connectors (connector_type,name) VALUES ('demo','Deterministic demo') ON CONFLICT (connector_type,name) DO UPDATE SET updated_at=now() RETURNING id`);
  const connectorId = connector.rows[0]?.id ?? (await pool.query<{ id: string }>("SELECT id FROM connectors WHERE connector_type='demo' ORDER BY created_at LIMIT 1")).rows[0].id;
  const device = await pool.query<{ id: string }>(`INSERT INTO devices (connector_id,vendor,vendor_device_id,model,name,capacity_wh,timezone) VALUES ($1,'demo','demo-delta-2-max','Delta 2 Max','Delta 2 Max',2048,$2) ON CONFLICT (connector_id,vendor_device_id) DO UPDATE SET updated_at=now() RETURNING id`, [connectorId, process.env.TZ ?? "UTC"]);
  return device.rows[0].id;
}

export async function persistTelemetry(deviceId: string, sample: NormalizedTelemetry) {
  await pool.query(`INSERT INTO telemetry_samples (device_id,observed_at,received_at,battery_soc_pct,battery_power_w,battery_charge_power_w,battery_discharge_power_w,solar_input_w,grid_input_w,ac_output_w,dc_output_w,total_output_w,battery_temperature_c,inverter_temperature_c,device_online,quality_flags,raw_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (device_id,observed_at) DO NOTHING`, [deviceId,sample.observedAt,sample.receivedAt,sample.batterySocPct,sample.batteryPowerW,sample.batteryChargePowerW,sample.batteryDischargePowerW,sample.solarInputW,sample.gridInputW,sample.acOutputW,sample.dcOutputW,sample.totalOutputW,sample.batteryTemperatureC,sample.inverterTemperatureC,sample.deviceOnline,sample.qualityFlags,process.env.STORE_RAW_PAYLOADS === "true" ? sample.raw : null]);
  await pool.query("UPDATE devices SET last_seen_at=$2,updated_at=now() WHERE id=$1", [deviceId, sample.observedAt]);
}
