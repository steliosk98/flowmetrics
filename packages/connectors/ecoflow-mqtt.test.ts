import { describe, expect, it } from "vitest";
import { applyMqttReport, parseStatusReport, prefixFor, quotaTopic } from "./ecoflow-mqtt";
import { mapDelta2Quota } from "./ecoflow-delta2-mapping";

/**
 * Payloads below were captured verbatim from a live DELTA 2 over MQTT, so these
 * tests pin the real wire format rather than an assumed one.
 */
describe("EcoFlow MQTT reports", () => {
  it("maps each module onto the same dotted namespace the HTTP API uses", () => {
    expect(prefixFor({ moduleType: 1, typeCode: "pdStatus" })).toBe("pd");
    expect(prefixFor({ moduleType: 2, typeCode: "bmsStatus" })).toBe("bms_bmsStatus");
    expect(prefixFor({ moduleType: 2, typeCode: "emsStatus" })).toBe("bms_emsStatus");
    expect(prefixFor({ moduleType: 3, typeCode: "invStatus" })).toBe("inv");
    expect(prefixFor({ moduleType: 5, typeCode: "mpptStatus" })).toBe("mppt");
  });

  it("refuses to guess between the two BMS report kinds without a typeCode", () => {
    // moduleType 2 covers both bmsStatus and emsStatus, which the HTTP API keeps
    // under different prefixes. Guessing would silently corrupt SOC.
    expect(prefixFor({ moduleType: 2 })).toBeUndefined();
    expect(prefixFor({ moduleType: 1 })).toBe("pd");
  });

  it("merges a captured mppt report into dotted keys", () => {
    const state = {};
    const wrote = applyMqttReport(state, {
      moduleType: 5, needAck: 0, id: 1035529737, time: 1035529737, version: "1.0", typeCode: "mpptStatus",
      params: { cfgChgWatts: 1000, chgType: 2, inVol: 27263, inWatts: 152, carState: 0 },
    });
    expect(wrote).toBe(true);
    expect(state).toMatchObject({ "mppt.chgType": 2, "mppt.inWatts": 152, "mppt.carState": 0 });
  });

  it("keeps the two BMS namespaces apart", () => {
    const state: Record<string, unknown> = {};
    applyMqttReport(state, { moduleType: 2, typeCode: "bmsStatus", params: { soc: 44, outputWatts: 0, inputWatts: 0, f32ShowSoc: 43.83 } });
    applyMqttReport(state, { moduleType: 2, typeCode: "emsStatus", params: { lcdShowSoc: 44, f32LcdShowSoc: 43.85, minDsgSoc: 20 } });
    expect(state["bms_bmsStatus.f32ShowSoc"]).toBe(43.83);
    expect(state["bms_emsStatus.f32LcdShowSoc"]).toBe(43.85);
    // inv.outputWatts must not be clobbered by the BMS field of the same name.
    expect(state["inv.outputWatts"]).toBeUndefined();
  });

  it("does not let same-named fields from different modules collide", () => {
    const state: Record<string, unknown> = {};
    applyMqttReport(state, { moduleType: 2, typeCode: "bmsStatus", params: { outputWatts: 0 } });
    applyMqttReport(state, { moduleType: 3, typeCode: "invStatus", params: { outputWatts: 104 } });
    expect(state["bms_bmsStatus.outputWatts"]).toBe(0);
    expect(state["inv.outputWatts"]).toBe(104);
  });

  it("ignores configuration frames", () => {
    const state = {};
    const wrote = applyMqttReport(state, {
      moduleType: 1, instructCode: "setReportCfg", id: 9959510, version: "1.0",
      params: { bmsRunIncre: 30000, pdInfoIncre: 2000 },
    });
    expect(wrote).toBe(false);
    expect(state).toEqual({});
  });

  it("drops per-cell arrays rather than storing them on every sample", () => {
    const state: Record<string, unknown> = {};
    applyMqttReport(state, { moduleType: 2, typeCode: "bmsStatus", params: { soc: 44, cellVol: [3308, 3309], cellTemp: [] } });
    expect(state["bms_bmsStatus.soc"]).toBe(44);
    expect(state["bms_bmsStatus.cellVol"]).toBeUndefined();
  });

  it("accumulates deltas into a state the existing DELTA 2 mapping understands", () => {
    // Each report carries only what changed; the merged state is what gets mapped.
    const state: Record<string, unknown> = {};
    applyMqttReport(state, { moduleType: 2, typeCode: "emsStatus", params: { f32LcdShowSoc: 43.85 } });
    applyMqttReport(state, { moduleType: 2, typeCode: "bmsStatus", params: { inputWatts: 0, outputWatts: 0, temp: 33, soh: 94 } });
    applyMqttReport(state, { moduleType: 5, typeCode: "mpptStatus", params: { inWatts: 152, chgType: 2 } });
    applyMqttReport(state, { moduleType: 3, typeCode: "invStatus", params: { outputWatts: 104, acInVol: 236030 } });
    applyMqttReport(state, { moduleType: 1, typeCode: "pdStatus", params: { wattsOutSum: 96, carWatts: 0, usb1Watts: 0 } });

    const sample = mapDelta2Quota(state, { deviceId: "sn", online: true });
    expect(sample.batterySocPct).toBeCloseTo(43.85);
    expect(sample.solarInputW).toBe(152);      // mppt.inWatts, confirmed solar by chgType 2
    expect(sample.acOutputW).toBe(104);        // inv.outputWatts, not the BMS field
    expect(sample.totalOutputW).toBe(96);
    expect(sample.batteryTemperatureC).toBe(33);
    expect(sample.batterySohPct).toBe(94);
    expect(sample.gridVoltageV).toBeCloseTo(236.03);
    expect(sample.qualityFlags).toBe(0);
  });

  it("reads the documented online flag from a status report", () => {
    expect(parseStatusReport({ id: "1", version: "1.0", params: { status: 1 } })).toBe(true);
    expect(parseStatusReport({ params: { status: 0 } })).toBe(false);
    expect(parseStatusReport({ params: {} })).toBeUndefined();
  });

  it("builds the documented topic", () => {
    expect(quotaTopic("open-abc", "R331X")).toBe("/open/open-abc/R331X/quota");
  });
});
