import { describe, expect, it } from "vitest";
import { demoSampleAt, EventDetector, integrateTelemetry, normalizedTelemetrySchema, splitSignedBatteryPower } from "./index";

describe("telemetry normalization", () => {
  it("splits the global signed convention", () => {
    expect(splitSignedBatteryPower(-420)).toEqual({ batteryPowerW: -420, batteryChargePowerW: 420, batteryDischargePowerW: 0 });
    expect(splitSignedBatteryPower(280).batteryDischargePowerW).toBe(280);
  });
  it("rejects impossible SOC", () => expect(() => normalizedTelemetrySchema.parse({ ...demoSampleAt(new Date()), batterySocPct: 120 })).toThrow());
});

describe("gap-aware integration", () => {
  it("uses trapezoidal integration", () => {
    const start = new Date("2026-08-07T10:00:00Z");
    const samples = [0, 10].map((seconds, i) => ({ ...demoSampleAt(new Date(start.getTime() + seconds * 1000)), solarInputW: i ? 600 : 400 }));
    expect(integrateTelemetry(samples).energyWh.solarInputW).toBeCloseTo(500 * 10 / 3600, 8);
  });
  it("does not integrate across a large gap", () => {
    const start = new Date("2026-08-07T10:00:00Z");
    const samples = [0, 10, 1810].map(seconds => ({ ...demoSampleAt(new Date(start.getTime() + seconds * 1000)), solarInputW: 500 }));
    const result = integrateTelemetry(samples);
    expect(result.energyWh.solarInputW).toBeCloseTo(500 * 10 / 3600);
    expect(result.gapSeconds).toBe(1800);
    expect(result.coveragePct).toBeLessThan(1);
  });
  it("sorts and deduplicates observed timestamps", () => {
    const a = demoSampleAt(new Date("2026-08-07T10:00:00Z")); const b = demoSampleAt(new Date("2026-08-07T10:00:10Z"));
    expect(integrateTelemetry([b, a, a]).duplicateCount).toBe(1);
  });
});

describe("event detector", () => {
  it("debounces solar start", () => {
    const detector = new EventDetector(); const start = new Date("2026-08-07T06:00:00Z");
    const events = [0, 10, 31].flatMap(seconds => detector.process({ ...demoSampleAt(new Date(start.getTime() + seconds * 1000)), solarInputW: 100 }));
    expect(events.some(event => event.type === "SOLAR_STARTED")).toBe(true);
  });
  it("reports gaps without fabricating energy", () => {
    const detector = new EventDetector(); detector.process(demoSampleAt(new Date("2026-08-07T10:00:00Z")));
    const events = detector.process(demoSampleAt(new Date("2026-08-07T10:10:00Z")));
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["TELEMETRY_GAP_STARTED", "TELEMETRY_GAP_ENDED"]));
  });
});
