import type { DiscoveredDevice, EnergyConnector, NormalizedTelemetry, TelemetryHandler } from "./telemetry";
import { splitSignedBatteryPower } from "./telemetry";

export function demoSampleAt(date: Date, deviceId = "demo-delta-2-max"): NormalizedTelemetry {
  const minutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const h = minutes / 60;
  const daylight = h >= 6.3 && h <= 19.2;
  const solar = daylight ? Math.max(0, Math.sin(((h - 6.3) / 12.9) * Math.PI) * 1375 * (h > 12.45 && h < 13.5 ? .64 : 1)) : 0;
  const output = 205 + ((h > 17.5 && h < 22.2) ? 315 : 0) + (((h > 7.2 && h < 8.4) || (h > 12.1 && h < 13)) ? 225 : 0);
  const grid = h < 5.8 ? 325 : h > 22.1 ? 460 : 0;
  const signedBattery = solar > output && h < 14.2 ? -(solar - output) : grid === 0 ? Math.min(output - Math.min(solar, output), 620) : 0;
  const soc = h < 6 ? 31 + h * .4 : h < 10.2 ? 33 + (h - 6) * 8 : h < 14.2 ? Math.min(100, 67 + (h - 10.2) * 10) : h < 18 ? 100 - (h - 14.2) * 1.3 : h < 22.1 ? 95 - (h - 18) * 12.3 : 44;
  return { observedAt: date, receivedAt: new Date(date.getTime() + 20), deviceId, batterySocPct: Math.max(0, Math.min(100, soc)), ...splitSignedBatteryPower(signedBattery), solarInputW: Math.round(solar), gridInputW: Math.round(grid), acOutputW: Math.round(output), dcOutputW: 0, totalOutputW: Math.round(output), batteryTemperatureC: 28.4, inverterTemperatureC: 35.2, deviceOnline: true, qualityFlags: 0 };
}

export class DemoConnector implements EnergyConnector {
  readonly id = "demo"; readonly vendor = "demo";
  private timer?: ReturnType<typeof setInterval>; private lastTelemetryAt?: Date;
  async validateConfiguration() { return { valid: true }; }
  async discoverDevices(): Promise<DiscoveredDevice[]> { return [{ vendorDeviceId: "demo-delta-2-max", vendor: "demo", model: "Delta 2 Max", name: "Delta 2 Max", capacityWh: 2048, capabilities: ["solar", "grid_input", "battery_soc", "ac_output"] }]; }
  async start(onTelemetry: TelemetryHandler) { if (this.timer) return; const emit = async () => { const sample = demoSampleAt(new Date()); this.lastTelemetryAt = sample.observedAt; await onTelemetry(sample); }; await emit(); this.timer = setInterval(() => void emit(), 10_000); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  getHealth() { return { status: this.timer ? "healthy" as const : "stopped" as const, lastTelemetryAt: this.lastTelemetryAt }; }
}
