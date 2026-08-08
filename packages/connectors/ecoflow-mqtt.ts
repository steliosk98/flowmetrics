import { z } from "zod";
import type { EcoFlowQuota } from "./ecoflow-client";

/**
 * EcoFlow MQTT report decoding.
 *
 * The HTTP quota endpoints serve the device's last *reported* state, which for an
 * idle DELTA 2 can be tens of minutes old. The device itself publishes to MQTT
 * continuously — measured at roughly one message per second with the mobile app
 * closed — so MQTT is the only way to get current data.
 *
 * Reports are **deltas**, each carrying only the fields that changed, namespaced
 * by module rather than by the dotted prefixes the HTTP API uses:
 *
 *   {"moduleType":5,"typeCode":"mpptStatus","params":{"chgType":2,"inWatts":152}}
 *
 * Merging them into the HTTP key space (`mppt.inWatts`, …) means the existing,
 * documented DELTA 2 field mapping applies unchanged — no second set of field
 * definitions to keep in sync.
 */

/**
 * `moduleType` values are from the official "ModuleType definition" table
 * (1: PD, 2: BMS, 3: INV, 4: BMS_SLAVE, 5: MPPT). `typeCode` distinguishes the
 * two BMS report kinds, which the HTTP API exposes under separate prefixes.
 */
export const MODULE_PREFIXES: Record<string, string> = {
  pdStatus: "pd",
  bmsStatus: "bms_bmsStatus",
  emsStatus: "bms_emsStatus",
  invStatus: "inv",
  mpptStatus: "mppt",
};

/** Fallback when a report carries no typeCode: module number alone. */
const MODULE_TYPE_PREFIXES: Record<number, string> = {
  1: "pd",
  3: "inv",
  5: "mppt",
  // moduleType 2 is ambiguous (bmsStatus vs emsStatus), so it is only resolved
  // via typeCode and deliberately absent here.
};

export const mqttReportSchema = z.object({
  moduleType: z.number().optional(),
  typeCode: z.string().optional(),
  instructCode: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type MqttReport = z.infer<typeof mqttReportSchema>;

/** Resolves the dotted prefix for a report, or undefined when it is not telemetry. */
export function prefixFor(report: MqttReport): string | undefined {
  if (report.typeCode && MODULE_PREFIXES[report.typeCode]) return MODULE_PREFIXES[report.typeCode];
  if (report.moduleType !== undefined) return MODULE_TYPE_PREFIXES[report.moduleType];
  return undefined;
}

/**
 * Merges one report into the accumulated quota state, in place.
 * Returns true when at least one value was written.
 *
 * Configuration frames (`instructCode`, e.g. setReportCfg) carry no measurements
 * and are ignored rather than polluting the state with reporting intervals.
 */
export function applyMqttReport(state: EcoFlowQuota, raw: unknown): boolean {
  const parsed = mqttReportSchema.safeParse(raw);
  if (!parsed.success) return false;
  const report = parsed.data;
  if (report.instructCode) return false;

  const prefix = prefixFor(report);
  if (!prefix || !report.params) return false;

  let wrote = false;
  for (const [key, value] of Object.entries(report.params)) {
    // Arrays (per-cell voltages and temperatures) are not part of the normalized
    // model and would bloat every stored payload.
    if (Array.isArray(value) || value === null || typeof value === "object") continue;
    state[`${prefix}.${key}`] = value;
    wrote = true;
  }
  return wrote;
}

/** Topic the device publishes its telemetry on. */
export function quotaTopic(certificateAccount: string, serialNumber: string): string {
  return `/open/${certificateAccount}/${serialNumber}/quota`;
}

/** Topic the device publishes online/offline transitions on. */
export function statusTopic(certificateAccount: string, serialNumber: string): string {
  return `/open/${certificateAccount}/${serialNumber}/status`;
}

export const statusReportSchema = z.object({
  params: z.object({ status: z.number() }).optional(),
});

/** Documented: "status: Device online or not 0: No, 1: Yes". */
export function parseStatusReport(raw: unknown): boolean | undefined {
  const parsed = statusReportSchema.safeParse(raw);
  const status = parsed.success ? parsed.data.params?.status : undefined;
  return status === undefined ? undefined : status === 1;
}
