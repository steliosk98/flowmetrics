import { DemoConnector, type EnergyConnector } from "../packages/core/index";
import { EcoFlowConnector } from "../packages/connectors/ecoflow";
import type { DeviceRegistration } from "./db";

/**
 * Chooses the collector from the environment and describes the device it will
 * register. `CONNECTOR` is authoritative; `DEMO_MODE` is kept for compatibility
 * with the original configuration.
 */

export type ConnectorMode = "demo" | "ecoflow" | "off";

export function resolveConnectorMode(env: NodeJS.ProcessEnv = process.env): ConnectorMode {
  const explicit = env.CONNECTOR?.trim().toLowerCase();
  if (explicit === "ecoflow") return "ecoflow";
  if (explicit === "demo") return "demo";
  if (explicit === "off" || explicit === "none") return "off";
  return env.DEMO_MODE === "false" ? "off" : "demo";
}

export interface BuiltConnector {
  mode: ConnectorMode;
  connector?: EnergyConnector;
  /** Device row to upsert before collection starts. */
  registration: DeviceRegistration;
  /** Expected seconds between samples, used for gap-aware integration. */
  expectedIntervalSeconds: number;
}

const DEMO_REGISTRATION: DeviceRegistration = {
  connectorType: "demo",
  connectorName: "Deterministic demo",
  vendor: "demo",
  vendorDeviceId: "demo-delta-2-max",
  model: "Delta 2 Max",
  name: "Delta 2 Max",
  capacityWh: 2048,
};

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required when CONNECTOR=ecoflow. Set it in your .env file.`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function buildConnector(
  env: NodeJS.ProcessEnv = process.env,
  logger?: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void },
): BuiltConnector {
  const mode = resolveConnectorMode(env);

  if (mode === "ecoflow") {
    const pollIntervalMs = positiveInt(env.ECOFLOW_POLL_INTERVAL_MS, 30_000);
    // Comma-separated. Empty means "every device bound to the account".
    const serialNumbers = (env.ECOFLOW_SERIAL_NUMBER ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const connector = new EcoFlowConnector(
      {
        accessKey: requireEnv(env, "ECOFLOW_ACCESS_KEY"),
        secretKey: requireEnv(env, "ECOFLOW_SECRET_KEY"),
        serialNumbers,
        host: env.ECOFLOW_HOST?.trim() || undefined,
        pollIntervalMs,
        transport: env.ECOFLOW_TRANSPORT?.trim().toLowerCase() === "poll" ? "poll" : "mqtt",
        sampleIntervalMs: positiveInt(env.ECOFLOW_SAMPLE_INTERVAL_MS, 10_000),
        includeRaw: env.STORE_RAW_PAYLOADS === "true",
      },
      { logger },
    );

    return {
      mode,
      connector,
      registration: {
        connectorType: "ecoflow",
        connectorName: "EcoFlow IoT Open Platform",
        vendor: "ecoflow",
        // Replaced per device once discovery resolves.
        vendorDeviceId: serialNumbers[0] ?? "pending-discovery",
        model: env.ECOFLOW_DEVICE_MODEL?.trim() || "EcoFlow DELTA 2",
        name: env.ECOFLOW_DEVICE_NAME?.trim() || "EcoFlow battery",
      },
      // On MQTT, samples are recorded at sampleIntervalMs, not the poll interval.
      expectedIntervalSeconds: Math.round(
        (env.ECOFLOW_TRANSPORT?.trim().toLowerCase() === "poll"
          ? pollIntervalMs
          : positiveInt(env.ECOFLOW_SAMPLE_INTERVAL_MS, 10_000)) / 1000,
      ),
    };
  }

  if (mode === "demo") {
    return { mode, connector: new DemoConnector(), registration: DEMO_REGISTRATION, expectedIntervalSeconds: 10 };
  }

  return { mode, registration: DEMO_REGISTRATION, expectedIntervalSeconds: 10 };
}
