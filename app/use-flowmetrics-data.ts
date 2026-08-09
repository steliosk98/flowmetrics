"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { combineSamples, COMBINED_DEVICE_ID } from "../packages/core/aggregate";
import type { NormalizedTelemetry } from "../packages/core/telemetry";

export { COMBINED_DEVICE_ID };

/**
 * Data access for the dashboard. Everything rendered in the UI comes from these
 * hooks — the pages hold no sample values of their own, so a figure on screen is
 * always something the collector actually recorded.
 */

export interface Sample {
  observedAt: string;
  receivedAt: string;
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
  deviceOnline?: boolean;
  qualityFlags?: number;
}

export interface CollectorHealth {
  status: "stopped" | "starting" | "healthy" | "degraded";
  lastTelemetryAt?: string;
  error?: string;
}

export interface StatusResponse {
  version: string;
  mode: "demo" | "ecoflow" | "off";
  databaseReady: boolean;
  rawPayloads: boolean;
  expectedIntervalSeconds: number;
  collector: CollectorHealth;
}

/** Postgres row; integer/numeric columns arrive as strings — pass them through toNum. */
export interface DailyRow {
  local_date: string;
  timezone: string;
  solar_energy_wh: Numeric;
  grid_energy_wh: Numeric;
  battery_charge_wh: Numeric;
  battery_discharge_wh: Numeric;
  ac_output_wh: Numeric;
  dc_output_wh: Numeric;
  total_output_wh: Numeric;
  peak_solar_w: Numeric;
  peak_solar_at: string | null;
  peak_grid_w: Numeric;
  peak_grid_at: string | null;
  peak_output_w: Numeric;
  peak_output_at: string | null;
  min_soc_pct: Numeric;
  max_soc_pct: Numeric;
  solar_active_seconds: Numeric;
  grid_import_seconds: Numeric;
  sample_count: Numeric;
  gap_seconds: Numeric;
  coverage_pct: Numeric;
}

export interface EventRow {
  id: string;
  event_type: string;
  started_at: string;
  ended_at: string | null;
  severity: "info" | "warning";
  value_start: number | null;
}

export interface DeviceSummary {
  id: string;
  vendorDeviceId: string;
  name: string;
  model: string;
  capacityWh: number | null;
  online: boolean | null;
  batterySocPct: number | null;
  /** When we last polled. */
  lastObservedAt: string | null;
  /** When the device itself last reported a change; can be much older. */
  lastChangedAt: string | null;
  /** True for the synthetic "All batteries" entry. */
  combined: boolean;
}

export interface DaysResponse {
  timezone: string;
  today: string;
  first: string;
  last: string;
  dates: string[];
}

export interface StatsResponse {
  sampleCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  recordedDays: number;
  averageCoveragePct: number | null;
  eventCount: number;
  databaseSize: string | null;
}

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** Re-fetch now. Resolves when the request settles, so callers can await it. */
  reload: () => Promise<void>;
}

/**
 * Fetches JSON once, then on an optional interval. `reloadToken` is a counter the
 * dashboard bumps when the user asks for a refresh; changing it re-runs the fetch.
 */
export function useJson<T>(path: string, refreshMs?: number, reloadToken = 0): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as T;
      if (!cancelled.current) setState({ data, loading: false });
    } catch (error) {
      if (!cancelled.current) setState({ error: (error as Error).message, loading: false });
    }
  }, [path]);

  useEffect(() => {
    cancelled.current = false;
    // load() suspends on `await fetch` before it ever reaches setState, so no
    // state update happens synchronously here. The rule cannot see across the
    // useCallback boundary to tell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = refreshMs ? setInterval(() => void load(), refreshMs) : undefined;
    return () => { cancelled.current = true; if (timer) clearInterval(timer); };
  }, [load, refreshMs, reloadToken]);

  return { ...state, reload: load };
}

/**
 * A clock that ticks, so relative times ("2 min ago", the stale badge) actually
 * advance instead of freezing until an unrelated re-render happens to occur.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Appends query parameters, preserving any already present. */
function withParams(path: string, params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (!pairs.length) return path;
  const query = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&");
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

/** Appends ?device= when a device is selected. */
export function withDevice(path: string, deviceId?: string): string {
  return withParams(path, { device: deviceId });
}

/** Appends ?device= and ?date= for the day-scoped views. */
export function withDay(path: string, deviceId?: string, date?: string): string {
  return withParams(path, { device: deviceId, date });
}

// ---- calendar days ---------------------------------------------------------

/** Shifts a `YYYY-MM-DD` date by whole days without touching timezones. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Human label for a calendar date. Rendered from the date parts directly rather
 * than `new Date(date)`, which would parse as UTC midnight and show the previous
 * day for anyone west of Greenwich.
 */
export function formatDayLabel(date: string, today?: string): string {
  if (today) {
    if (date === today) return "Today";
    if (date === shiftDate(today, -1)) return "Yesterday";
  }
  const [y, m, d] = date.split("-").map(Number);
  const local = new Date(y, m - 1, d);
  const sameYear = today ? Number(today.slice(0, 4)) === y : true;
  return local.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export type SampleMap = Record<string, Sample>;

/**
 * One EventSource for the whole dashboard.
 *
 * The stream is deliberately not pinned to a device, so a single connection
 * carries every battery. Opening one per component would exhaust the browser's
 * per-origin connection limit (about six) once a few batteries are bound.
 *
 * Falls back to polling each device's /current when the stream cannot be held.
 */
export function useLiveFeed(deviceIds: string[], reloadToken = 0): { samples: SampleMap; connected: boolean } {
  const [samples, setSamples] = useState<SampleMap>({});
  const [connected, setConnected] = useState(false);
  // Joined so the effect re-runs when the set of devices actually changes,
  // not on every render that rebuilds the array.
  const key = deviceIds.join(",");

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const apply = (next: Sample | null) => {
      if (cancelled || !next?.deviceId) return;
      setSamples(previous => {
        const held = previous[next.deviceId];
        // Ignore out-of-order frames so a reading never jumps backwards.
        if (held && new Date(next.observedAt) < new Date(held.observedAt)) return previous;
        return { ...previous, [next.deviceId]: next };
      });
    };

    const pollOnce = async () => {
      const ids = key ? key.split(",") : [];
      await Promise.all(ids.map(async id => {
        try {
          const response = await fetch(withDevice("/api/v1/current", id));
          if (response.ok) apply((await response.json()) as Sample | null);
        } catch { /* keep the last known reading */ }
      }));
    };

    const startPolling = () => {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), 15_000);
    };

    // Seed immediately; the stream then keeps things current.
    void pollOnce();

    try {
      source = new EventSource("/api/v1/live");
      source.addEventListener("telemetry", event => {
        setConnected(true);
        try { apply(JSON.parse((event as MessageEvent).data) as Sample); } catch { /* malformed frame */ }
      });
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        // EventSource retries on its own; polling covers the meantime.
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => { cancelled = true; source?.close(); if (pollTimer) clearInterval(pollTimer); };
  }, [key, reloadToken]);

  return { samples, connected };
}

/**
 * Site-level reading derived from the live feed, using the same tested
 * aggregation the server uses so the two can never disagree. Samples cross the
 * wire as ISO strings, so they are converted to Dates and back around the call.
 */
export function combineLiveSamples(
  samples: Sample[],
  capacityOf: (deviceId: string) => number | undefined,
  expectedDeviceCount: number,
): Sample | undefined {
  if (!samples.length) return undefined;
  const asDomain = samples.map(s => ({
    ...s,
    observedAt: new Date(s.observedAt),
    receivedAt: new Date(s.receivedAt),
    qualityFlags: s.qualityFlags ?? 0,
  })) as NormalizedTelemetry[];

  const combined = combineSamples(asDomain, capacityOf, expectedDeviceCount);
  if (!combined) return undefined;
  return { ...combined, observedAt: combined.observedAt.toISOString(), receivedAt: combined.receivedAt.toISOString() } as Sample;
}

/** Net power for a battery, used for the at-a-glance battery cards. */
export function batteryFlow(sample: Sample | undefined) {
  return {
    solarW: sample?.solarInputW,
    gridW: sample?.gridInputW,
    loadW: sample?.totalOutputW,
    chargeW: sample?.batteryChargePowerW,
    dischargeW: sample?.batteryDischargePowerW,
  };
}

// ---- formatting helpers ----------------------------------------------------

/**
 * node-postgres returns bigint and numeric columns as strings so precision is
 * never silently lost, so every value crossing this boundary is coerced once
 * here. Returns undefined for anything that is not a real number — callers
 * render an em dash rather than substituting a zero.
 */
export type Numeric = number | string | null | undefined;

export function toNum(value: Numeric): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Watts, or an em dash when the device does not report the field at all. */
export function formatWatts(value: Numeric): string {
  const n = toNum(value);
  return n === undefined ? "—" : `${Math.round(n).toLocaleString()} W`;
}

export function formatKwh(wh: Numeric, digits = 2): string {
  const n = toNum(wh);
  return n === undefined ? "—" : (n / 1000).toFixed(digits);
}

export function formatPct(value: Numeric, digits = 0): string {
  const n = toNum(value);
  return n === undefined ? "—" : `${n.toFixed(digits)}%`;
}

export function formatCount(value: Numeric): string {
  const n = toNum(value);
  return n === undefined ? "—" : n.toLocaleString();
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(seconds: Numeric): string {
  const n = toNum(seconds);
  if (n === undefined) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Battery sign convention: positive discharges, negative charges. */
export function batteryLabel(sample: Sample | undefined): string {
  if (!sample) return "—";
  const charge = sample.batteryChargePowerW;
  const discharge = sample.batteryDischargePowerW;
  if (charge === undefined && discharge === undefined) return "not reported";
  if ((charge ?? 0) > (discharge ?? 0)) return `${formatWatts(charge)} charging`;
  if ((discharge ?? 0) > 0) return `${formatWatts(discharge)} discharging`;
  return "idle";
}

export const EVENT_LABELS: Record<string, string> = {
  SOLAR_STARTED: "Solar production started",
  SOLAR_STOPPED: "Solar production stopped",
  GRID_IMPORT_STARTED: "Grid import started",
  GRID_IMPORT_STOPPED: "Grid import stopped",
  BATTERY_CHARGE_STARTED: "Battery charging started",
  BATTERY_CHARGE_STOPPED: "Battery charging stopped",
  BATTERY_DISCHARGE_STARTED: "Battery discharge started",
  BATTERY_DISCHARGE_STOPPED: "Battery discharge stopped",
  BATTERY_FULL: "Battery reached full",
  BATTERY_LOW: "Battery low",
  DEVICE_ONLINE: "Device came online",
  DEVICE_OFFLINE: "Device went offline",
  TELEMETRY_GAP_STARTED: "Telemetry gap started",
  TELEMETRY_GAP_ENDED: "Telemetry gap ended",
};

export function eventKind(type: string): "solar" | "grid" | "charge" | "discharge" | "full" | "quality" {
  if (type.startsWith("SOLAR")) return "solar";
  if (type.startsWith("GRID")) return "grid";
  if (type.startsWith("BATTERY_CHARGE")) return "charge";
  if (type.startsWith("BATTERY_DISCHARGE")) return "discharge";
  if (type === "BATTERY_FULL" || type === "BATTERY_LOW") return "full";
  return "quality";
}
