import { z } from "zod";
import type { DiscoveredDevice, EnergyConnector, TelemetryHandler } from "../core/index";

export const ecoFlowConfigurationSchema = z.object({ accessKey: z.string().min(1), secretKey: z.string().min(1) });

/**
 * Deliberately contains no network contract until the official developer docs
 * can be inspected and fixture payloads can be captured from authorized hardware.
 */
export class EcoFlowConnector implements EnergyConnector {
  readonly id = "ecoflow"; readonly vendor = "ecoflow";
  async validateConfiguration(config: unknown) { const parsed=ecoFlowConfigurationSchema.safeParse(config);return parsed.success?{valid:false,message:"Credentials are structurally valid, but this build has no verified EcoFlow transport contract."}:{valid:false,message:"Access and secret credentials are required."}; }
  async discoverDevices(): Promise<DiscoveredDevice[]> { throw new Error("EcoFlow discovery is unavailable until the current official API contract is verified."); }
  async start(onTelemetry: TelemetryHandler) { void onTelemetry; throw new Error("EcoFlow telemetry is unavailable until the current official API contract is verified."); }
  async stop() {}
  getHealth() { return { status:"stopped" as const, error:"Official API contract not yet verified" }; }
}
