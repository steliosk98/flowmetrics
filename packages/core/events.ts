import type { NormalizedTelemetry } from "./telemetry";

export type EventType = "SOLAR_STARTED" | "SOLAR_STOPPED" | "GRID_IMPORT_STARTED" | "GRID_IMPORT_STOPPED" | "BATTERY_CHARGE_STARTED" | "BATTERY_CHARGE_STOPPED" | "BATTERY_DISCHARGE_STARTED" | "BATTERY_DISCHARGE_STOPPED" | "BATTERY_FULL" | "BATTERY_LOW" | "DEVICE_ONLINE" | "DEVICE_OFFLINE" | "TELEMETRY_GAP_STARTED" | "TELEMETRY_GAP_ENDED";
export interface EnergyEvent { type: EventType; at: Date; value?: number; severity: "info" | "warning"; }

type BinaryState = { active: boolean; pending: boolean | null; pendingSince?: Date };

export class EventDetector {
  private states = new Map<string, BinaryState>();
  private lastSample?: NormalizedTelemetry;
  private fullLatched = false;
  private lowLatched = false;
  constructor(private config = { debounceSeconds: 30, solarOnW: 35, solarOffW: 20, gridOnW: 40, gridOffW: 15, batteryOnW: 30, batteryOffW: 10, lowSocPct: 15 }) {}

  process(sample: NormalizedTelemetry): EnergyEvent[] {
    const events: EnergyEvent[] = [];
    if (this.lastSample) {
      const gap = (sample.observedAt.getTime() - this.lastSample.observedAt.getTime()) / 1000;
      if (gap > 120) events.push({ type: "TELEMETRY_GAP_STARTED", at: this.lastSample.observedAt, value: gap, severity: "warning" }, { type: "TELEMETRY_GAP_ENDED", at: sample.observedAt, value: gap, severity: "info" });
      if (sample.deviceOnline !== this.lastSample.deviceOnline && sample.deviceOnline != null) events.push({ type: sample.deviceOnline ? "DEVICE_ONLINE" : "DEVICE_OFFLINE", at: sample.observedAt, severity: sample.deviceOnline ? "info" : "warning" });
    }
    events.push(...this.transition("solar", (sample.solarInputW ?? 0) >= this.config.solarOnW, (sample.solarInputW ?? 0) <= this.config.solarOffW, sample, "SOLAR_STARTED", "SOLAR_STOPPED", sample.solarInputW));
    events.push(...this.transition("grid", (sample.gridInputW ?? 0) >= this.config.gridOnW, (sample.gridInputW ?? 0) <= this.config.gridOffW, sample, "GRID_IMPORT_STARTED", "GRID_IMPORT_STOPPED", sample.gridInputW));
    events.push(...this.transition("charge", (sample.batteryChargePowerW ?? 0) >= this.config.batteryOnW, (sample.batteryChargePowerW ?? 0) <= this.config.batteryOffW, sample, "BATTERY_CHARGE_STARTED", "BATTERY_CHARGE_STOPPED", sample.batteryChargePowerW));
    events.push(...this.transition("discharge", (sample.batteryDischargePowerW ?? 0) >= this.config.batteryOnW, (sample.batteryDischargePowerW ?? 0) <= this.config.batteryOffW, sample, "BATTERY_DISCHARGE_STARTED", "BATTERY_DISCHARGE_STOPPED", sample.batteryDischargePowerW));
    if ((sample.batterySocPct ?? 0) >= 99.5 && !this.fullLatched) { this.fullLatched = true; events.push({ type: "BATTERY_FULL", at: sample.observedAt, value: sample.batterySocPct, severity: "info" }); }
    if ((sample.batterySocPct ?? 100) < 98) this.fullLatched = false;
    if ((sample.batterySocPct ?? 100) <= this.config.lowSocPct && !this.lowLatched) { this.lowLatched = true; events.push({ type: "BATTERY_LOW", at: sample.observedAt, value: sample.batterySocPct, severity: "warning" }); }
    if ((sample.batterySocPct ?? 0) > this.config.lowSocPct + 3) this.lowLatched = false;
    this.lastSample = sample;
    return events;
  }

  private transition(key: string, on: boolean, off: boolean, sample: NormalizedTelemetry, started: EventType, stopped: EventType, value?: number): EnergyEvent[] {
    const state = this.states.get(key) ?? { active: false, pending: null };
    const desired = state.active ? !off : on;
    if (desired === state.active) { state.pending = null; state.pendingSince = undefined; this.states.set(key, state); return []; }
    if (state.pending !== desired) { state.pending = desired; state.pendingSince = sample.observedAt; this.states.set(key, state); return []; }
    const elapsed = (sample.observedAt.getTime() - state.pendingSince!.getTime()) / 1000;
    if (elapsed < this.config.debounceSeconds) return [];
    state.active = desired; state.pending = null; state.pendingSince = undefined; this.states.set(key, state);
    return [{ type: desired ? started : stopped, at: sample.observedAt, value, severity: "info" }];
  }
}
