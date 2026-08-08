import { describe, expect, it } from "vitest";
import { AGGREGATE_FLAGS, combineDailySeries, combineSamples, combineSeries, combineSoc } from "./aggregate";
import type { NormalizedTelemetry } from "./telemetry";

const at = (iso: string) => new Date(iso);

function sample(deviceId: string, observedAt: string, fields: Partial<NormalizedTelemetry> = {}): NormalizedTelemetry {
  return { deviceId, observedAt: at(observedAt), receivedAt: at(observedAt), qualityFlags: 0, ...fields };
}

const capacities: Record<string, number | undefined> = { a: 1000, b: 2000 };
const capacityOf = (id: string) => capacities[id];

describe("combining batteries", () => {
  it("weights state of charge by capacity rather than averaging", () => {
    // 1000 Wh at 100% + 2000 Wh at 25% = 1500 Wh stored of 3000 Wh = 50%.
    // A plain mean would say 62.5%, which no battery and no site is at.
    const { socPct, weighted } = combineSoc([
      { socPct: 100, capacityWh: 1000 },
      { socPct: 25, capacityWh: 2000 },
    ]);
    expect(socPct).toBeCloseTo(50);
    expect(weighted).toBe(true);
  });

  it("falls back to an unweighted mean only when a capacity is unknown, and flags it", () => {
    const combined = combineSamples(
      [sample("a", "2026-08-08T06:00:00Z", { batterySocPct: 40 }), sample("unknown", "2026-08-08T06:00:00Z", { batterySocPct: 60 })],
      capacityOf,
    );
    expect(combined?.batterySocPct).toBeCloseTo(50);
    expect((combined?.qualityFlags ?? 0) & AGGREGATE_FLAGS.SOC_UNWEIGHTED).toBeTruthy();
  });

  it("sums power across batteries", () => {
    const combined = combineSamples(
      [
        sample("a", "2026-08-08T06:00:00Z", { solarInputW: 115, gridInputW: 0, totalOutputW: 100, batteryChargePowerW: 15, batteryDischargePowerW: 0 }),
        sample("b", "2026-08-08T06:00:00Z", { solarInputW: 135, gridInputW: 26, totalOutputW: 27, batteryChargePowerW: 134, batteryDischargePowerW: 0 }),
      ],
      capacityOf,
    );
    expect(combined?.solarInputW).toBe(250);
    expect(combined?.gridInputW).toBe(26);
    expect(combined?.totalOutputW).toBe(127);
    expect(combined?.batteryChargePowerW).toBe(149);
    expect(combined?.batteryPowerW).toBe(-149);
  });

  it("reports the hottest pack, not the average temperature", () => {
    const combined = combineSamples(
      [
        sample("a", "2026-08-08T06:00:00Z", { batteryTemperatureC: 30 }),
        sample("b", "2026-08-08T06:00:00Z", { batteryTemperatureC: 48 }),
      ],
      capacityOf,
    );
    expect(combined?.batteryTemperatureC).toBe(48);
  });

  it("is only as current as its stalest battery", () => {
    const combined = combineSamples(
      [sample("a", "2026-08-08T06:00:00Z"), sample("b", "2026-08-08T05:30:00Z")],
      capacityOf,
    );
    expect(combined?.observedAt.toISOString()).toBe("2026-08-08T05:30:00.000Z");
  });

  it("is online only when every battery is", () => {
    const both = combineSamples([sample("a", "2026-08-08T06:00:00Z", { deviceOnline: true }), sample("b", "2026-08-08T06:00:00Z", { deviceOnline: true })], capacityOf);
    expect(both?.deviceOnline).toBe(true);
    const one = combineSamples([sample("a", "2026-08-08T06:00:00Z", { deviceOnline: true }), sample("b", "2026-08-08T06:00:00Z", { deviceOnline: false })], capacityOf);
    expect(one?.deviceOnline).toBe(false);
  });

  it("flags a reading that not every battery contributed to", () => {
    const combined = combineSamples(
      [sample("a", "2026-08-08T06:00:00Z", { solarInputW: 100 }), sample("b", "2026-08-08T06:00:00Z", {})],
      capacityOf,
    );
    expect(combined?.solarInputW).toBe(100);
    expect((combined?.qualityFlags ?? 0) & AGGREGATE_FLAGS.PARTIAL).toBeTruthy();
  });

  it("does not call a reading partial when no battery reports a field at all", () => {
    // A DELTA 2 has one PV input, so solarInput2W is never reported by any of
    // them. That is 'not measured', not 'partially summed' — flagging it would
    // set PARTIAL on every combined reading and make the flag meaningless.
    const combined = combineSamples(
      [
        sample("a", "2026-08-08T06:00:00Z", { solarInputW: 100, solarInput2W: undefined }),
        sample("b", "2026-08-08T06:00:00Z", { solarInputW: 200, solarInput2W: undefined }),
      ],
      capacityOf,
    );
    expect(combined?.solarInput2W).toBeUndefined();
    expect((combined?.qualityFlags ?? 0) & AGGREGATE_FLAGS.PARTIAL).toBeFalsy();
  });

  it("carries per-battery quality flags through to the site reading", () => {
    const combined = combineSamples(
      [sample("a", "2026-08-08T06:00:00Z", { qualityFlags: 1 << 4 }), sample("b", "2026-08-08T06:00:00Z", { qualityFlags: 0 })],
      capacityOf,
    );
    expect((combined?.qualityFlags ?? 0) & (1 << 4)).toBeTruthy();
  });
});

describe("combining series", () => {
  it("aligns samples that land a few seconds apart into one bucket", () => {
    const series = combineSeries(
      [
        [sample("a", "2026-08-08T06:00:01Z", { solarInputW: 100 }), sample("a", "2026-08-08T06:00:31Z", { solarInputW: 110 })],
        [sample("b", "2026-08-08T06:00:03Z", { solarInputW: 200 }), sample("b", "2026-08-08T06:00:33Z", { solarInputW: 210 })],
      ],
      capacityOf,
      30,
    );
    expect(series).toHaveLength(2);
    expect(series[0].solarInputW).toBe(300);
    expect(series[1].solarInputW).toBe(320);
  });

  it("drops a bucket where a battery did not report rather than under-summing", () => {
    // Summing only the battery that reported would show site power halving,
    // which never happened — a gap is the honest answer.
    const series = combineSeries(
      [
        [sample("a", "2026-08-08T06:00:00Z", { solarInputW: 100 }), sample("a", "2026-08-08T06:01:00Z", { solarInputW: 100 })],
        [sample("b", "2026-08-08T06:00:00Z", { solarInputW: 200 })],
      ],
      capacityOf,
      30,
    );
    expect(series).toHaveLength(1);
    expect(series[0].solarInputW).toBe(300);
  });

  it("returns a single battery's series unchanged", () => {
    const only = [sample("a", "2026-08-08T06:00:00Z", { solarInputW: 100 })];
    expect(combineSeries([only, []], capacityOf, 30)).toEqual(only);
  });

  it("handles no data at all", () => {
    expect(combineSeries([[], []], capacityOf, 30)).toEqual([]);
  });
});

describe("combining daily rollups", () => {
  it("sums energy and takes the worst coverage", () => {
    const [combined] = combineDailySeries([
      { local_date: "2026-08-08", timezone: "Europe/Nicosia", solar_energy_wh: 1000, grid_energy_wh: 500, total_output_wh: 1200, coverage_pct: 100, sample_count: "180" },
      { local_date: "2026-08-08", timezone: "Europe/Nicosia", solar_energy_wh: 2000, grid_energy_wh: 250, total_output_wh: 900, coverage_pct: 92.5, sample_count: "180" },
    ]);
    expect(combined.solar_energy_wh).toBe(3000);
    expect(combined.grid_energy_wh).toBe(750);
    expect(combined.total_output_wh).toBe(2100);
    expect(combined.coverage_pct).toBe(92.5);
    // Strings from Postgres must not concatenate into "180180".
    expect(combined.sample_count).toBe(360);
  });

  it("omits peaks instead of summing values from different moments", () => {
    const [combined] = combineDailySeries([
      { local_date: "2026-08-08", peak_solar_w: 800, peak_solar_at: "2026-08-08T10:00:00Z", max_soc_pct: 90 },
      { local_date: "2026-08-08", peak_solar_w: 700, peak_solar_at: "2026-08-08T14:00:00Z", max_soc_pct: 80 },
    ]);
    expect(combined.peak_solar_w).toBeNull();
    expect(combined.peak_solar_at).toBeNull();
    expect(combined.max_soc_pct).toBeNull();
  });

  it("groups by date, newest first", () => {
    const rows = combineDailySeries([
      { local_date: "2026-08-07", solar_energy_wh: 1 },
      { local_date: "2026-08-08", solar_energy_wh: 2 },
      { local_date: "2026-08-07", solar_energy_wh: 3 },
    ]);
    expect(rows.map(r => r.local_date)).toEqual(["2026-08-08", "2026-08-07"]);
    expect(rows[1].solar_energy_wh).toBe(4);
  });
});
