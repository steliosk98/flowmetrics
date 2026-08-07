import { integrateTelemetry, type NormalizedTelemetry } from "../packages/core/index";
import { pool } from "./db";

type TelemetryRow = Record<string, unknown>;
function rowToSample(row: TelemetryRow): NormalizedTelemetry {
  return {
    deviceId: String(row.device_id), observedAt: new Date(String(row.observed_at)), receivedAt: new Date(String(row.received_at)),
    batterySocPct: row.battery_soc_pct == null ? undefined : Number(row.battery_soc_pct), batteryPowerW: row.battery_power_w == null ? undefined : Number(row.battery_power_w),
    batteryChargePowerW: row.battery_charge_power_w == null ? undefined : Number(row.battery_charge_power_w), batteryDischargePowerW: row.battery_discharge_power_w == null ? undefined : Number(row.battery_discharge_power_w),
    solarInputW: row.solar_input_w == null ? undefined : Number(row.solar_input_w), gridInputW: row.grid_input_w == null ? undefined : Number(row.grid_input_w),
    acOutputW: row.ac_output_w == null ? undefined : Number(row.ac_output_w), dcOutputW: row.dc_output_w == null ? undefined : Number(row.dc_output_w), totalOutputW: row.total_output_w == null ? undefined : Number(row.total_output_w),
    batteryTemperatureC: row.battery_temperature_c == null ? undefined : Number(row.battery_temperature_c), inverterTemperatureC: row.inverter_temperature_c == null ? undefined : Number(row.inverter_temperature_c),
    deviceOnline: row.device_online == null ? undefined : Boolean(row.device_online), qualityFlags: Number(row.quality_flags ?? 0),
  };
}

export async function getSamples(deviceId: string, from: Date, to: Date, maxPoints = 3000) {
  const count = await pool.query<{ count: string }>("SELECT count(*) FROM telemetry_samples WHERE device_id=$1 AND observed_at BETWEEN $2 AND $3", [deviceId, from, to]);
  const stride = Math.max(1, Math.ceil(Number(count.rows[0].count) / maxPoints));
  const rows = await pool.query(`SELECT * FROM (SELECT *,row_number() OVER (ORDER BY observed_at) AS rn FROM telemetry_samples WHERE device_id=$1 AND observed_at BETWEEN $2 AND $3) s WHERE rn % $4 = 1 OR rn = 1 ORDER BY observed_at`, [deviceId, from, to, stride]);
  return rows.rows.map(rowToSample);
}

export async function rebuildDay(deviceId: string, day: Date) {
  const device = await pool.query<{ timezone: string; capacity_wh: number | null }>("SELECT timezone,capacity_wh FROM devices WHERE id=$1", [deviceId]);
  if (!device.rowCount) return;
  const timezone = device.rows[0].timezone;
  const start = new Date(day); start.setUTCHours(0,0,0,0); const end = new Date(start.getTime() + 86_400_000);
  const samples = await getSamples(deviceId, start, end, Number.MAX_SAFE_INTEGER);
  if (samples.length < 2) return;
  const integrated = integrateTelemetry(samples);
  const peak = (field: keyof NormalizedTelemetry) => samples.reduce((best, sample) => Number(sample[field] ?? 0) > Number(best[field] ?? 0) ? sample : best, samples[0]);
  const socSamples = samples.filter(sample => sample.batterySocPct != null);
  const minSoc = socSamples.reduce((a,b) => a.batterySocPct! < b.batterySocPct! ? a : b, socSamples[0]); const maxSoc = socSamples.reduce((a,b) => a.batterySocPct! > b.batterySocPct! ? a : b, socSamples[0]);
  const activeSeconds = (field: keyof NormalizedTelemetry, threshold: number) => samples.slice(1).reduce((sum,sample,i) => Number(sample[field] ?? 0) >= threshold ? sum + Math.min(120,(sample.observedAt.getTime()-samples[i].observedAt.getTime())/1000) : sum,0);
  const capacity = device.rows[0].capacity_wh;
  await pool.query(`INSERT INTO energy_daily (device_id,local_date,timezone,solar_energy_wh,grid_energy_wh,battery_charge_wh,battery_discharge_wh,ac_output_wh,dc_output_wh,total_output_wh,peak_solar_w,peak_solar_at,peak_grid_w,peak_grid_at,peak_output_w,peak_output_at,min_soc_pct,min_soc_at,max_soc_pct,max_soc_at,solar_active_seconds,grid_import_seconds,battery_charging_seconds,battery_discharging_seconds,equivalent_cycle_fraction,sample_count,valid_integration_seconds,gap_seconds,coverage_pct,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now()) ON CONFLICT (device_id,local_date) DO UPDATE SET solar_energy_wh=EXCLUDED.solar_energy_wh,grid_energy_wh=EXCLUDED.grid_energy_wh,battery_charge_wh=EXCLUDED.battery_charge_wh,battery_discharge_wh=EXCLUDED.battery_discharge_wh,total_output_wh=EXCLUDED.total_output_wh,peak_solar_w=EXCLUDED.peak_solar_w,peak_solar_at=EXCLUDED.peak_solar_at,peak_grid_w=EXCLUDED.peak_grid_w,peak_grid_at=EXCLUDED.peak_grid_at,peak_output_w=EXCLUDED.peak_output_w,peak_output_at=EXCLUDED.peak_output_at,min_soc_pct=EXCLUDED.min_soc_pct,min_soc_at=EXCLUDED.min_soc_at,max_soc_pct=EXCLUDED.max_soc_pct,max_soc_at=EXCLUDED.max_soc_at,sample_count=EXCLUDED.sample_count,valid_integration_seconds=EXCLUDED.valid_integration_seconds,gap_seconds=EXCLUDED.gap_seconds,coverage_pct=EXCLUDED.coverage_pct,updated_at=now()`, [deviceId,start.toISOString().slice(0,10),timezone,integrated.energyWh.solarInputW,integrated.energyWh.gridInputW,integrated.energyWh.batteryChargePowerW,integrated.energyWh.batteryDischargePowerW,integrated.energyWh.acOutputW,integrated.energyWh.dcOutputW,integrated.energyWh.totalOutputW,peak("solarInputW").solarInputW,peak("solarInputW").observedAt,peak("gridInputW").gridInputW,peak("gridInputW").observedAt,peak("totalOutputW").totalOutputW,peak("totalOutputW").observedAt,minSoc?.batterySocPct,minSoc?.observedAt,maxSoc?.batterySocPct,maxSoc?.observedAt,activeSeconds("solarInputW",35),activeSeconds("gridInputW",40),activeSeconds("batteryChargePowerW",30),activeSeconds("batteryDischargePowerW",30),capacity ? integrated.energyWh.batteryDischargePowerW/capacity : null,integrated.sampleCount,integrated.validIntegrationSeconds,integrated.gapSeconds,integrated.coveragePct]);
}
