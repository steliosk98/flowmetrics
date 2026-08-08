"use client";

import { useEffect, useRef, useState } from "react";

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
  lastObservedAt: string | null;
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
}

/** Fetches JSON once, then on an optional interval. */
export function useJson<T>(path: string, refreshMs?: number): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(path, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!cancelled) setState({ data, loading: false });
      } catch (error) {
        if (!cancelled) setState({ error: (error as Error).message, loading: false });
      }
    };
    void load();
    const timer = refreshMs ? setInterval(() => void load(), refreshMs) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [path, refreshMs]);

  return state;
}

/** Appends ?device= when a device is selected, preserving any existing query. */
export function withDevice(path: string, deviceId?: string): string {
  if (!deviceId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}device=${encodeURIComponent(deviceId)}`;
}

/**
 * Latest measurement for one device: seeded from /api/v1/current, then kept
 * current by the SSE stream. Falls back to polling if the stream cannot be
 * established.
 */
export function useLiveSample(deviceId?: string): { sample?: Sample; connected: boolean; loading: boolean } {
  // The sample is stored together with the device it came from, so switching
  // devices makes the stale reading fall away on the next render rather than
  // needing a setState inside the effect body.
  const [state, setState] = useState<{ deviceId?: string; sample?: Sample; loading: boolean }>({ deviceId, loading: true });
  const [connected, setConnected] = useState(false);
  const sampleRef = useRef<Sample | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    sampleRef.current = undefined;
    const currentPath = withDevice("/api/v1/current", deviceId);

    const apply = (next: Sample | null) => {
      if (cancelled) return;
      if (!next) { setState({ deviceId, sample: undefined, loading: false }); return; }
      // Ignore out-of-order frames so the reading never jumps backwards.
      const previous = sampleRef.current;
      if (previous && new Date(next.observedAt) < new Date(previous.observedAt)) return;
      sampleRef.current = next;
      setState({ deviceId, sample: next, loading: false });
    };

    const startPolling = () => {
      if (pollTimer) return;
      const poll = async () => {
        try {
          const response = await fetch(currentPath);
          if (response.ok) apply((await response.json()) as Sample | null);
        } catch { /* leave the last known reading in place */ }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), 15_000);
    };

    void (async () => {
      try {
        const response = await fetch(currentPath);
        if (response.ok) apply((await response.json()) as Sample | null);
        else if (!cancelled) setState({ deviceId, sample: undefined, loading: false });
      } catch {
        if (!cancelled) setState({ deviceId, sample: undefined, loading: false });
      }
    })();

    try {
      source = new EventSource(withDevice("/api/v1/live", deviceId));
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
  }, [deviceId]);

  // Anything held for a different device is not this device's reading.
  const fresh = state.deviceId === deviceId;
  return { sample: fresh ? state.sample : undefined, connected, loading: fresh ? state.loading : true };
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
