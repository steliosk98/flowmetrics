import { z } from "zod";

const optionalNonNegative = z.number().finite().nonnegative().optional();

export const normalizedTelemetrySchema = z.object({
  observedAt: z.coerce.date(),
  receivedAt: z.coerce.date(),
  deviceId: z.string().min(1),
  batterySocPct: z.number().finite().min(0).max(100).optional(),
  batteryPowerW: z.number().finite().optional(),
  batteryChargePowerW: optionalNonNegative,
  batteryDischargePowerW: optionalNonNegative,
  solarInputW: optionalNonNegative,
  solarInput1W: optionalNonNegative,
  solarInput2W: optionalNonNegative,
  gridInputW: optionalNonNegative,
  gridVoltageV: optionalNonNegative,
  gridFrequencyHz: optionalNonNegative,
  gridConnected: z.boolean().optional(),
  acOutputW: optionalNonNegative,
  dcOutputW: optionalNonNegative,
  totalOutputW: optionalNonNegative,
  batteryTemperatureC: z.number().finite().optional(),
  inverterTemperatureC: z.number().finite().optional(),
  batterySohPct: z.number().finite().min(0).max(100).optional(),
  cycleCount: z.number().int().nonnegative().optional(),
  deviceOnline: z.boolean().optional(),
  qualityFlags: z.number().int().nonnegative().default(0),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type NormalizedTelemetry = z.infer<typeof normalizedTelemetrySchema>;

export function splitSignedBatteryPower(powerW: number): Pick<NormalizedTelemetry, "batteryPowerW" | "batteryChargePowerW" | "batteryDischargePowerW"> {
  return {
    batteryPowerW: powerW,
    batteryChargePowerW: powerW < 0 ? Math.abs(powerW) : 0,
    batteryDischargePowerW: powerW > 0 ? powerW : 0,
  };
}

export interface DiscoveredDevice {
  vendorDeviceId: string;
  vendor: string;
  model: string;
  name: string;
  capacityWh?: number;
  capabilities: string[];
}

export type TelemetryHandler = (sample: NormalizedTelemetry) => Promise<void> | void;

export interface EnergyConnector {
  readonly id: string;
  readonly vendor: string;
  validateConfiguration(config: unknown): Promise<{ valid: boolean; message?: string }>;
  discoverDevices(): Promise<DiscoveredDevice[]>;
  start(onTelemetry: TelemetryHandler): Promise<void>;
  stop(): Promise<void>;
  getHealth(): { status: "stopped" | "starting" | "healthy" | "degraded"; lastTelemetryAt?: Date; error?: string };
}
