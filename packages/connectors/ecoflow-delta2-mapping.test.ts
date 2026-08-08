import { describe, expect, it } from "vitest";
import { deriveCapacityWh, mapDelta2Quota, QUALITY_FLAGS } from "./ecoflow-delta2-mapping";

const deviceId = "test-device";

describe("DELTA 2 quota mapping", () => {
  it("maps the documented partial payload without inventing absent measurements", () => {
    // Verbatim from the official Delta 2 Max GetAllQuotaResponse example.
    const documented = {
      "bms_emsStatus.dsgCmd": 1,
      "bms_bmsStatus.maxVolDiff": 4,
      "bms_bmsStatus.balanceState": 0,
      "inv.acChgRatedPower": 2400,
      "pd.usb1Watts": 0,
      "inv.cfgAcXboost": 1,
      "inv.outTemp": 35,
      "mppt.dcdc12vAmp": 0,
      "bms_emsStatus.chgAmp": 1000,
      "mppt.pv2MpptTemp": 34,
      "inv.inputWatts": 0,
      "bms_emsStatus.chgState": 3,
      "bms_emsStatus.openBmsIdx": 1,
      "mppt.pv2CfgChgType": 1,
      "pd.typec2Temp": 30,
      "pd.chgDsgState": 1,
      "pd.typec1Watts": 0,
      "mppt.carStandbyMin": 306,
      "pd.soc": 83,
      "inv.invOutAmp": 0,
      "bms_emsStatus.fanLevel": 0,
      "inv.standbyMin": 0,
      "mppt.pv2ChgType": 0,
      "pd.acAutoPause": 1,
    };

    const sample = mapDelta2Quota(documented, { deviceId, online: true });

    expect(sample.batterySocPct).toBe(83);
    expect(sample.qualityFlags & QUALITY_FLAGS.SOC_INTEGER_ONLY).toBeTruthy();
    expect(sample.gridInputW).toBe(0);
    expect(sample.inverterTemperatureC).toBe(35);
    expect(sample.dcOutputW).toBe(0);

    // Absent from the payload — must stay undefined, never zero.
    expect(sample.solarInputW).toBeUndefined();
    expect(sample.acOutputW).toBeUndefined();
    expect(sample.batteryChargePowerW).toBeUndefined();
    expect(sample.batteryDischargePowerW).toBeUndefined();
    expect(sample.batteryTemperatureC).toBeUndefined();
  });

  it("reads battery charge and discharge from the BMS", () => {
    const charging = mapDelta2Quota(
      { "bms_bmsStatus.inputWatts": 620, "bms_bmsStatus.outputWatts": 0 },
      { deviceId },
    );
    expect(charging.batteryChargePowerW).toBe(620);
    expect(charging.batteryDischargePowerW).toBe(0);
    expect(charging.batteryPowerW).toBe(-620);
    expect(charging.qualityFlags & QUALITY_FLAGS.BATTERY_POWER_DERIVED).toBeFalsy();

    const discharging = mapDelta2Quota(
      { "bms_bmsStatus.inputWatts": 0, "bms_bmsStatus.outputWatts": 415 },
      { deviceId },
    );
    expect(discharging.batteryChargePowerW).toBe(0);
    expect(discharging.batteryDischargePowerW).toBe(415);
    expect(discharging.batteryPowerW).toBe(415);
  });

  it("falls back to the input/output balance only when the BMS is silent, and flags it", () => {
    const sample = mapDelta2Quota({ "pd.wattsInSum": 800, "pd.wattsOutSum": 200 }, { deviceId });
    expect(sample.batteryChargePowerW).toBe(600);
    expect(sample.qualityFlags & QUALITY_FLAGS.BATTERY_POWER_DERIVED).toBeTruthy();
  });

  it("counts DC input as solar only when the device confirms a panel", () => {
    const solar = mapDelta2Quota({ "pd.pv1ChargeWatts": 430, "pd.pv1ChargeType": 2 }, { deviceId });
    expect(solar.solarInputW).toBe(430);
    expect(solar.qualityFlags & QUALITY_FLAGS.SOLAR_ATTRIBUTION_UNVERIFIED).toBeFalsy();

    // Type 1 is the mains/DC adapter — real charge power, but not generation.
    const adapter = mapDelta2Quota({ "pd.pv1ChargeWatts": 430, "pd.pv1ChargeType": 1 }, { deviceId });
    expect(adapter.solarInputW).toBeUndefined();
    expect(adapter.solarInput1W).toBeUndefined();

    // No charge-type field at all: count it, but mark the attribution unverified.
    const unknown = mapDelta2Quota({ "pd.pv1ChargeWatts": 430 }, { deviceId });
    expect(unknown.solarInputW).toBe(430);
    expect(unknown.qualityFlags & QUALITY_FLAGS.SOLAR_ATTRIBUTION_UNVERIFIED).toBeTruthy();
  });

  it("sums both PV inputs", () => {
    const sample = mapDelta2Quota(
      {
        "pd.pv1ChargeWatts": 300,
        "pd.pv1ChargeType": 2,
        "pd.pv2ChargeWatts": 250,
        "pd.pv2ChargeType": 2,
      },
      { deviceId },
    );
    expect(sample.solarInputW).toBe(550);
    expect(sample.solarInput1W).toBe(300);
    expect(sample.solarInput2W).toBe(250);
  });

  it("accepts string-encoded quota values, as EcoFlow's own example returns", () => {
    const sample = mapDelta2Quota({ "pd.soc": "76", "inv.outputWatts": "312" }, { deviceId });
    expect(sample.batterySocPct).toBe(76);
    expect(sample.acOutputW).toBe(312);
  });

  it("derives grid presence and voltage from the documented millivolt field", () => {
    const online = mapDelta2Quota({ "inv.acInVol": 231_400, "inv.acInFreq": 50 }, { deviceId });
    expect(online.gridVoltageV).toBeCloseTo(231.4);
    expect(online.gridFrequencyHz).toBe(50);
    expect(online.gridConnected).toBe(true);

    const disconnected = mapDelta2Quota({ "inv.acInVol": 0 }, { deviceId });
    expect(disconnected.gridConnected).toBe(false);

    // No AC voltage field at all is unknown, not "disconnected".
    expect(mapDelta2Quota({}, { deviceId }).gridConnected).toBeUndefined();
  });

  it("flags samples captured while the device is offline", () => {
    const sample = mapDelta2Quota({ "pd.soc": 50 }, { deviceId, online: false });
    expect(sample.qualityFlags & QUALITY_FLAGS.DEVICE_OFFLINE).toBeTruthy();
    expect(sample.deviceOnline).toBe(false);
  });

  it("computes capacity from BMS capacity and voltage, or nothing at all", () => {
    // 2048 Wh class pack: 43000 mAh at 47.6 V.
    expect(deriveCapacityWh({ "bms_bmsStatus.fullCap": 43_000, "bms_bmsStatus.vol": 47_600 })).toBe(2047);
    expect(deriveCapacityWh({ "bms_bmsStatus.fullCap": 43_000 })).toBeUndefined();
    expect(deriveCapacityWh({})).toBeUndefined();
  });

  it("produces a sample that satisfies the normalized telemetry schema", async () => {
    const { normalizedTelemetrySchema } = await import("../core/telemetry");
    const sample = mapDelta2Quota(
      {
        "pd.soc": 83,
        "bms_bmsStatus.inputWatts": 0,
        "bms_bmsStatus.outputWatts": 415,
        "pd.pv1ChargeWatts": 120,
        "pd.pv1ChargeType": 2,
        "inv.inputWatts": 0,
        "inv.outputWatts": 380,
        "pd.wattsOutSum": 415,
        "bms_bmsStatus.temp": 29,
        "bms_bmsStatus.soh": 98,
      },
      { deviceId, online: true },
    );
    expect(() => normalizedTelemetrySchema.parse(sample)).not.toThrow();
  });
});
