import type { NormalizedTelemetry } from "./telemetry";

/**
 * Combining several batteries into one site-level view.
 *
 * Power and energy are additive, so they are summed. Most other quantities are
 * not, and this module refuses to fake them:
 *
 * - **State of charge** is weighted by usable capacity, not averaged. Two packs
 *   at 50% and 100% with different capacities are not "75% full"; the site is
 *   (stored Wh / total Wh) full.
 * - **Peaks** are dropped when combining pre-aggregated daily rows. Two batteries
 *   peaking at different moments never produced the sum of their peaks, and the
 *   real combined peak cannot be recovered without the underlying samples.
 * - **Temperatures** report the hottest pack rather than an average, because an
 *   average hides the one that is running hot.
 * - A time bucket is only emitted when **every** battery reported in it. Summing
 *   a subset would understate site power and silently corrupt energy totals.
 */

/** Extends the connector flag space (bits 0-4); see ecoflow-delta2-mapping.ts. */
export const AGGREGATE_FLAGS = {
  /** At least one battery did not contribute a value to this reading. */
  PARTIAL: 1 << 5,
  /** Capacity was unknown for a battery, so SOC is an unweighted mean. */
  SOC_UNWEIGHTED: 1 << 6,
} as const;

/** Marker device id for the combined view. */
export const COMBINED_DEVICE_ID = "all";

export type CapacityLookup = (deviceId: string) => number | undefined;

function sumDefined(values: (number | undefined)[]): { total?: number; missing: boolean } {
  const present = values.filter((v): v is number => v !== undefined);
  // A field no battery reports is simply not measured — that is not a partial
  // sum. Only a field some reported and others did not makes the total partial.
  if (!present.length) return { total: undefined, missing: false };
  return { total: present.reduce((a, b) => a + b, 0), missing: present.length !== values.length };
}

function maxDefined(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

/**
 * Capacity-weighted state of charge: total stored energy over total capacity.
 * Falls back to an unweighted mean only when a capacity is unknown, and says so.
 */
export function combineSoc(
  entries: { socPct?: number; capacityWh?: number }[],
): { socPct?: number; weighted: boolean } {
  const withSoc = entries.filter(e => e.socPct !== undefined);
  if (!withSoc.length) return { socPct: undefined, weighted: true };

  const allHaveCapacity = withSoc.every(e => e.capacityWh !== undefined && e.capacityWh > 0);
  if (allHaveCapacity) {
    const capacity = withSoc.reduce((a, e) => a + (e.capacityWh as number), 0);
    const stored = withSoc.reduce((a, e) => a + ((e.socPct as number) / 100) * (e.capacityWh as number), 0);
    return { socPct: (stored / capacity) * 100, weighted: true };
  }
  return { socPct: withSoc.reduce((a, e) => a + (e.socPct as number), 0) / withSoc.length, weighted: false };
}

/** Combines one reading per battery into a single site reading. */
export function combineSamples(
  samples: NormalizedTelemetry[],
  capacityOf: CapacityLookup,
  expectedDeviceCount = samples.length,
): NormalizedTelemetry | undefined {
  if (!samples.length) return undefined;

  let qualityFlags = samples.reduce((flags, s) => flags | (s.qualityFlags ?? 0), 0);
  if (samples.length < expectedDeviceCount) qualityFlags |= AGGREGATE_FLAGS.PARTIAL;

  const power = (pick: (s: NormalizedTelemetry) => number | undefined) => {
    const { total, missing } = sumDefined(samples.map(pick));
    if (missing) qualityFlags |= AGGREGATE_FLAGS.PARTIAL;
    return total;
  };

  const charge = power(s => s.batteryChargePowerW);
  const discharge = power(s => s.batteryDischargePowerW);

  const soc = combineSoc(samples.map(s => ({ socPct: s.batterySocPct, capacityWh: capacityOf(s.deviceId) })));
  if (!soc.weighted) qualityFlags |= AGGREGATE_FLAGS.SOC_UNWEIGHTED;

  const sohEntries = samples
    .map(s => ({ socPct: s.batterySohPct, capacityWh: capacityOf(s.deviceId) }))
    .filter(e => e.socPct !== undefined);

  return {
    // The site is only as current as its stalest battery.
    observedAt: new Date(Math.min(...samples.map(s => s.observedAt.getTime()))),
    receivedAt: new Date(Math.max(...samples.map(s => s.receivedAt.getTime()))),
    deviceId: COMBINED_DEVICE_ID,
    batterySocPct: soc.socPct,
    batteryPowerW: charge === undefined && discharge === undefined ? undefined : (discharge ?? 0) - (charge ?? 0),
    batteryChargePowerW: charge,
    batteryDischargePowerW: discharge,
    solarInputW: power(s => s.solarInputW),
    solarInput1W: power(s => s.solarInput1W),
    solarInput2W: power(s => s.solarInput2W),
    gridInputW: power(s => s.gridInputW),
    // Voltage and frequency are properties of the shared supply, not a sum.
    gridVoltageV: maxDefined(samples.map(s => s.gridVoltageV)),
    gridFrequencyHz: maxDefined(samples.map(s => s.gridFrequencyHz)),
    gridConnected: samples.some(s => s.gridConnected === true)
      ? true
      : samples.every(s => s.gridConnected === false) ? false : undefined,
    acOutputW: power(s => s.acOutputW),
    dcOutputW: power(s => s.dcOutputW),
    totalOutputW: power(s => s.totalOutputW),
    // Hottest pack, so a single hot battery is never averaged away.
    batteryTemperatureC: maxDefined(samples.map(s => s.batteryTemperatureC)),
    inverterTemperatureC: maxDefined(samples.map(s => s.inverterTemperatureC)),
    batterySohPct: combineSoc(sohEntries).socPct,
    // The site is online only when every battery is.
    deviceOnline: samples.every(s => s.deviceOnline === true)
      ? true
      : samples.some(s => s.deviceOnline === false) ? false : undefined,
    qualityFlags,
  };
}

/**
 * Aligns per-battery series onto shared time buckets and combines each one.
 * Buckets where a battery is missing are dropped rather than under-summed, so
 * a gap in one battery becomes a gap for the site.
 */
export function combineSeries(
  seriesByDevice: NormalizedTelemetry[][],
  capacityOf: CapacityLookup,
  bucketSeconds: number,
): NormalizedTelemetry[] {
  const contributing = seriesByDevice.filter(series => series.length > 0);
  if (contributing.length === 0) return [];
  if (contributing.length === 1) return contributing[0];

  const bucketMs = Math.max(1, bucketSeconds) * 1000;
  const bucketOf = (date: Date) => Math.round(date.getTime() / bucketMs) * bucketMs;

  const byDevice = contributing.map(series => {
    const buckets = new Map<number, NormalizedTelemetry>();
    // Later samples win, so a bucket holds the most recent reading it contains.
    for (const sample of series) buckets.set(bucketOf(sample.observedAt), sample);
    return buckets;
  });

  const shared = [...byDevice[0].keys()]
    .filter(key => byDevice.every(map => map.has(key)))
    .sort((a, b) => a - b);

  return shared
    .map(key => combineSamples(byDevice.map(map => map.get(key) as NormalizedTelemetry), capacityOf, byDevice.length))
    .filter((sample): sample is NormalizedTelemetry => sample !== undefined);
}

/** Numeric columns come off Postgres as strings; coerce before arithmetic. */
function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const ADDITIVE_DAILY_COLUMNS = [
  "solar_energy_wh", "grid_energy_wh", "battery_charge_wh", "battery_discharge_wh",
  "ac_output_wh", "dc_output_wh", "total_output_wh", "sample_count", "gap_seconds",
  "valid_integration_seconds", "solar_active_seconds", "grid_import_seconds",
  "battery_charging_seconds", "battery_discharging_seconds",
] as const;

/**
 * Combines daily rollup rows for one date.
 *
 * Energy sums are exact: total site energy is the sum of each battery's energy.
 * Peaks and SOC extremes are deliberately omitted — they occurred at different
 * moments per battery, so neither the sum nor the max is the site's real figure,
 * and recovering it needs the underlying samples.
 */
export function combineDailyRows(rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (!rows.length) return undefined;

  const combined: Record<string, unknown> = {
    local_date: rows[0].local_date,
    timezone: rows[0].timezone,
    device_id: COMBINED_DEVICE_ID,
  };

  for (const column of ADDITIVE_DAILY_COLUMNS) {
    const values = rows.map(row => toNumber(row[column]));
    const present = values.filter((v): v is number => v !== undefined);
    combined[column] = present.length ? present.reduce((a, b) => a + b, 0) : null;
  }

  // The site's coverage is that of its worst-covered battery.
  const coverage = rows.map(row => toNumber(row.coverage_pct)).filter((v): v is number => v !== undefined);
  combined.coverage_pct = coverage.length ? Math.min(...coverage) : null;

  // Not derivable from pre-aggregated rows — left null rather than approximated.
  for (const column of [
    "peak_solar_w", "peak_solar_at", "peak_grid_w", "peak_grid_at", "peak_output_w", "peak_output_at",
    "min_soc_pct", "min_soc_at", "max_soc_pct", "max_soc_at", "equivalent_cycle_fraction",
  ]) combined[column] = null;

  return combined;
}

/** Combines daily rows from several batteries into one series keyed by date. */
export function combineDailySeries(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row.local_date);
    byDate.set(key, [...(byDate.get(key) ?? []), row]);
  }
  return [...byDate.values()]
    .map(combineDailyRows)
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .sort((a, b) => String(b.local_date).localeCompare(String(a.local_date)));
}
