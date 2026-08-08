import type { NormalizedTelemetry } from "../core/telemetry";
import { splitSignedBatteryPower } from "../core/telemetry";
import type { EcoFlowQuota } from "./ecoflow-client";

/**
 * DELTA 2 / DELTA 2 Max quota -> FlowMetrics normalized telemetry.
 *
 * Every key referenced here appears in the official "GetAllQuotaResponse" field
 * table on the EcoFlow developer portal for Delta 2 Max, quoted in the comment
 * beside it. No key, unit or scale factor is inferred.
 *
 * Module prefixes: pd = power delivery board, bms_bmsStatus / bms_emsStatus =
 * battery, inv = inverter (AC side), mppt = solar / DC-in charge controller.
 */

/** Bit flags recorded on each sample when a reading is present but not fully trustworthy. */
export const QUALITY_FLAGS = {
  /** Device reported offline by the device-list endpoint; values are the last known ones. */
  DEVICE_OFFLINE: 1 << 0,
  /** SOC came from an integer field because the decimal field was absent. */
  SOC_INTEGER_ONLY: 1 << 1,
  /** DC input power was counted as solar without a charge-type field confirming a panel. */
  SOLAR_ATTRIBUTION_UNVERIFIED: 1 << 2,
  /** Battery power was derived from the input/output totals, not read from the BMS. */
  BATTERY_POWER_DERIVED: 1 << 3,
} as const;

/**
 * Quota values are documented as ints, but EcoFlow's own Delta Pro example
 * returns them as strings. Accept both; reject anything non-finite.
 */
function num(quota: EcoFlowQuota, key: string): number | undefined {
  const raw = quota[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** First key that carries a usable value, in preference order. */
function firstNum(quota: EcoFlowQuota, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = num(quota, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function sumNum(quota: EcoFlowQuota, ...keys: string[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const key of keys) {
    const value = num(quota, key);
    if (value !== undefined) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

/** Power readings are non-negative in the normalized schema; clamp tiny negative noise to 0. */
function clampPower(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value < 0 ? 0 : value;
}

/**
 * "PV1 charging type: 0: none; 1: adapter; 2: solar panel" (pd.pv1ChargeType /
 * pd.pv2ChargeType) and "Actual PV1 charging type: ... 2: MPPT (solar power)"
 * (mppt.chgType / mppt.pv2ChgType).
 *
 * The DC input port accepts a mains adapter and a car charger as well as panels,
 * so power arriving there is only solar when the device says it is. Returns
 * undefined when no charge-type field is present.
 */
function isSolarInput(quota: EcoFlowQuota, pdKey: string, mpptKey: string): boolean | undefined {
  const pdType = num(quota, pdKey);
  if (pdType !== undefined) return pdType === 2; // 2: solar panel
  const mpptType = num(quota, mpptKey);
  if (mpptType !== undefined) return mpptType === 2; // 2: MPPT (solar power)
  return undefined;
}

export interface MapOptions {
  deviceId: string;
  observedAt?: Date;
  receivedAt?: Date;
  /** From the device-list endpoint: "online: 0: No, 1: Yes". */
  online?: boolean;
  /** Attach the source quota for debugging when STORE_RAW_PAYLOADS is on. */
  includeRaw?: boolean;
}

export function mapDelta2Quota(quota: EcoFlowQuota, options: MapOptions): NormalizedTelemetry {
  const observedAt = options.observedAt ?? new Date();
  let qualityFlags = 0;

  // ---- State of charge -------------------------------------------------
  // "bms_emsStatus.f32LcdShowSoc: SOC value displayed on LCD: used for showing
  // the SOC value with a decimal point" — preferred for resolution.
  // "bms_bmsStatus.f32ShowSoc: Battery level SOC_float"
  // "pd.soc: Show SOC" / "bms_bmsStatus.soc: Battery level" — integers.
  let batterySocPct = firstNum(quota, "bms_emsStatus.f32LcdShowSoc", "bms_bmsStatus.f32ShowSoc");
  if (batterySocPct === undefined) {
    batterySocPct = firstNum(quota, "pd.soc", "bms_emsStatus.lcdShowSoc", "bms_bmsStatus.soc");
    if (batterySocPct !== undefined) qualityFlags |= QUALITY_FLAGS.SOC_INTEGER_ONLY;
  }
  if (batterySocPct !== undefined) batterySocPct = Math.min(100, Math.max(0, batterySocPct));

  // ---- Solar / DC input ------------------------------------------------
  // "pd.pv1ChargeWatts: PV1 power" and "pd.pv2ChargeWatts: PV2 power" are plain
  // watts. mppt.inWatts ("PV1 input power (W)") is the documented fallback for
  // PV1. mppt.pv2InWatts is deliberately not used as a fallback: its published
  // description carries a x10 scaling note that does not apply to the pd fields.
  const pv1Watts = clampPower(firstNum(quota, "pd.pv1ChargeWatts", "mppt.inWatts"));
  const pv2Watts = clampPower(num(quota, "pd.pv2ChargeWatts"));

  const pv1IsSolar = isSolarInput(quota, "pd.pv1ChargeType", "mppt.chgType");
  const pv2IsSolar = isSolarInput(quota, "pd.pv2ChargeType", "mppt.pv2ChgType");

  let solarInputW: number | undefined;
  for (const [watts, isSolar] of [
    [pv1Watts, pv1IsSolar],
    [pv2Watts, pv2IsSolar],
  ] as const) {
    if (watts === undefined) continue;
    if (isSolar === false) continue; // confirmed adapter/car input — not solar
    if (isSolar === undefined && watts > 0) qualityFlags |= QUALITY_FLAGS.SOLAR_ATTRIBUTION_UNVERIFIED;
    solarInputW = (solarInputW ?? 0) + watts;
  }

  // ---- Grid (AC) input -------------------------------------------------
  // "inv.inputWatts: Charging power (W)" is the AC-side charge power.
  // "inv.acInVol: Inverter input voltage (mV)", "inv.acInFreq: Inverter input frequency (Hz)".
  const gridInputW = clampPower(num(quota, "inv.inputWatts"));
  const acInVolMv = num(quota, "inv.acInVol");
  const gridVoltageV = acInVolMv === undefined ? undefined : acInVolMv / 1000;
  const gridFrequencyHz = num(quota, "inv.acInFreq");
  const gridConnected = acInVolMv === undefined ? undefined : acInVolMv > 0;

  // ---- Outputs ---------------------------------------------------------
  // "inv.outputWatts: Discharging power (W)" / "pd.invOutWatts: Inverter output power".
  const acOutputW = clampPower(firstNum(quota, "inv.outputWatts", "pd.invOutWatts"));

  // Individual DC port powers, each documented as watts on the PD board.
  const dcOutputW = clampPower(
    sumNum(
      quota,
      "pd.carWatts", // "CAR output power (W)"
      "pd.usb1Watts", // "Common USB1 output power (W)"
      "pd.usb2Watts", // "Common USB2 output power for PD (W)"
      "pd.qcUsb1Watts", // "qc_usb1 output power (W)"
      "pd.qcUsb2Watts", // "qc_usb2 output power (W)"
      "pd.typec1Watts", // "Type-C 1 output power (W)"
      "pd.typec2Watts", // "Type-C 2 output power (W)"
      "pd.wireWatts", // "Wireless charging output power (W)"
    ),
  );

  // "pd.wattsOutSum: Total output power (W)" / "pd.wattsInSum: Total input power (W)"
  const totalOutputW = clampPower(num(quota, "pd.wattsOutSum"));
  const totalInputW = clampPower(num(quota, "pd.wattsInSum"));

  // ---- Battery power ---------------------------------------------------
  // "bms_bmsStatus.inputWatts: Input power" / "bms_bmsStatus.outputWatts: Output power"
  // are the battery's own charge and discharge power.
  const bmsIn = clampPower(num(quota, "bms_bmsStatus.inputWatts"));
  const bmsOut = clampPower(num(quota, "bms_bmsStatus.outputWatts"));

  let battery: Pick<NormalizedTelemetry, "batteryPowerW" | "batteryChargePowerW" | "batteryDischargePowerW">;
  if (bmsIn !== undefined || bmsOut !== undefined) {
    const charge = bmsIn ?? 0;
    const discharge = bmsOut ?? 0;
    // splitSignedBatteryPower treats positive as discharge, negative as charge.
    battery = splitSignedBatteryPower(discharge - charge);
  } else if (totalInputW !== undefined && totalOutputW !== undefined) {
    // Fall back to the site balance only when the BMS fields are absent, and say so.
    qualityFlags |= QUALITY_FLAGS.BATTERY_POWER_DERIVED;
    battery = splitSignedBatteryPower(totalOutputW - totalInputW);
  } else {
    battery = { batteryPowerW: undefined, batteryChargePowerW: undefined, batteryDischargePowerW: undefined };
  }

  if (options.online === false) qualityFlags |= QUALITY_FLAGS.DEVICE_OFFLINE;

  return {
    observedAt,
    receivedAt: options.receivedAt ?? new Date(),
    deviceId: options.deviceId,
    batterySocPct,
    ...battery,
    solarInputW,
    solarInput1W: pv1IsSolar === false ? undefined : pv1Watts,
    solarInput2W: pv2IsSolar === false ? undefined : pv2Watts,
    gridInputW,
    gridVoltageV,
    gridFrequencyHz,
    gridConnected,
    acOutputW,
    dcOutputW,
    totalOutputW,
    // "bms_bmsStatus.temp: Temperature (℃)", "inv.outTemp: INV temperature (℃)"
    batteryTemperatureC: firstNum(quota, "bms_bmsStatus.temp", "bms_bmsStatus.cellTemp"),
    inverterTemperatureC: num(quota, "inv.outTemp"),
    // "bms_bmsStatus.soh: Health status"
    batterySohPct: num(quota, "bms_bmsStatus.soh"),
    deviceOnline: options.online,
    qualityFlags,
    raw: options.includeRaw ? quota : undefined,
  };
}

/**
 * Usable capacity in watt-hours from the BMS, using
 * "bms_bmsStatus.fullCap: Full capacity (mAh)" and "bms_bmsStatus.vol: Voltage (mV)".
 * Returns undefined rather than a nominal figure when either field is absent.
 */
export function deriveCapacityWh(quota: EcoFlowQuota): number | undefined {
  const fullCapMah = num(quota, "bms_bmsStatus.fullCap");
  const voltageMv = num(quota, "bms_bmsStatus.vol");
  if (!fullCapMah || !voltageMv) return undefined;
  return Math.round((fullCapMah * voltageMv) / 1_000_000);
}

/** Capabilities actually evidenced by the quota payload, for device registration. */
export function deriveCapabilities(quota: EcoFlowQuota): string[] {
  const capabilities: string[] = [];
  if (num(quota, "pd.soc") !== undefined || num(quota, "bms_bmsStatus.soc") !== undefined) capabilities.push("battery_soc");
  if (num(quota, "pd.pv1ChargeWatts") !== undefined || num(quota, "mppt.inWatts") !== undefined) capabilities.push("solar");
  if (num(quota, "pd.pv2ChargeWatts") !== undefined) capabilities.push("solar_dual_input");
  if (num(quota, "inv.inputWatts") !== undefined) capabilities.push("grid_input");
  if (num(quota, "inv.outputWatts") !== undefined) capabilities.push("ac_output");
  if (num(quota, "pd.carWatts") !== undefined) capabilities.push("dc_output");
  if (num(quota, "bms_bmsStatus.soh") !== undefined) capabilities.push("battery_health");
  return capabilities;
}
