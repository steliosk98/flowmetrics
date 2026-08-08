import { z } from "zod";
import type { DiscoveredDevice, EnergyConnector, TelemetryHandler } from "../core/index";
import { DEFAULT_ECOFLOW_HOST, EcoFlowClient, type EcoFlowDeviceListEntry } from "./ecoflow-client";
import { deriveCapabilities, deriveCapacityWh, mapDelta2Quota, QUALITY_FLAGS, telemetrySignature } from "./ecoflow-delta2-mapping";

export { DEFAULT_ECOFLOW_HOST } from "./ecoflow-client";

/**
 * EcoFlow IoT Open Platform connector.
 *
 * Transport is HTTP polling of the documented `/iot-open/sign/device/quota/all`
 * endpoint. The MQTT push topics are documented and the certificate endpoint is
 * implemented in the client, but polling is what this connector uses: it needs
 * no extra dependency and the historian integrates power over time rather than
 * reacting to individual pushes.
 *
 * Telemetry field mapping is DELTA 2 / DELTA 2 Max specific — see
 * ecoflow-delta2-mapping.ts. Other model families report different quota keys
 * and need their own mapping module.
 */

export const ecoFlowConfigurationSchema = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  /** Pin specific devices. When empty, every device bound to the account is collected. */
  serialNumbers: z.array(z.string().min(1)).optional(),
  host: z.string().url().optional(),
  pollIntervalMs: z.number().int().min(5_000).max(600_000).optional(),
  deviceListRefreshMs: z.number().int().min(30_000).optional(),
  includeRaw: z.boolean().optional(),
});

export type EcoFlowConfiguration = z.infer<typeof ecoFlowConfigurationSchema>;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_DEVICE_LIST_REFRESH_MS = 300_000;

type Health = ReturnType<EnergyConnector["getHealth"]>;

export class EcoFlowConnector implements EnergyConnector {
  readonly id = "ecoflow";
  readonly vendor = "ecoflow";

  private readonly config: EcoFlowConfiguration;
  private readonly client: EcoFlowClient;
  private readonly logger: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void };

  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private polling = false;
  private status: Health["status"] = "stopped";
  private lastError?: string;
  private lastTelemetryAt?: Date;
  private consecutiveFailures = 0;

  /** Serial -> last known online state. Populated from the device-list endpoint. */
  private targets = new Map<string, boolean | undefined>();
  /** Serial -> fingerprint of the last reading, to spot re-served cloud reports. */
  private signatures = new Map<string, string>();
  private deviceListCheckedAt = 0;

  constructor(
    config: EcoFlowConfiguration,
    options: { logger?: EcoFlowConnector["logger"]; client?: EcoFlowClient } = {},
  ) {
    this.config = ecoFlowConfigurationSchema.parse(config);
    for (const sn of this.config.serialNumbers ?? []) this.targets.set(sn, undefined);
    this.client =
      options.client ??
      new EcoFlowClient(
        { accessKey: this.config.accessKey, secretKey: this.config.secretKey },
        { host: this.config.host ?? DEFAULT_ECOFLOW_HOST },
      );
    this.logger = options.logger ?? { warn: () => {}, info: () => {} };
  }

  private get pollIntervalMs() {
    return this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Verifies the credentials against the live API rather than only their shape. */
  async validateConfiguration(config: unknown): Promise<{ valid: boolean; message?: string }> {
    const parsed = ecoFlowConfigurationSchema.safeParse(config);
    if (!parsed.success) return { valid: false, message: "accessKey and secretKey are required." };

    const client = new EcoFlowClient(
      { accessKey: parsed.data.accessKey, secretKey: parsed.data.secretKey },
      { host: parsed.data.host ?? DEFAULT_ECOFLOW_HOST },
    );
    try {
      const devices = await client.listDevices();
      if (!devices.length) {
        return { valid: false, message: "Credentials accepted, but no devices are bound to this EcoFlow account." };
      }
      const unknown = (parsed.data.serialNumbers ?? []).filter(sn => !devices.some(device => device.sn === sn));
      if (unknown.length) {
        return {
          valid: false,
          message: `Not bound to this account: ${unknown.join(", ")}. Bound: ${devices.map(d => d.sn).join(", ")}`,
        };
      }
      return { valid: true, message: `Verified against ${devices.length} bound device(s).` };
    } catch (error) {
      return { valid: false, message: (error as Error).message };
    }
  }

  async discoverDevices(): Promise<DiscoveredDevice[]> {
    const devices = await this.client.listDevices();
    const wanted = this.config.serialNumbers ?? [];
    const selected = wanted.length ? devices.filter(d => wanted.includes(d.sn)) : devices;

    return Promise.all(
      selected.map(async (device): Promise<DiscoveredDevice> => {
        let capacityWh: number | undefined;
        let capabilities: string[] = [];
        try {
          const quota = await this.client.getAllQuota(device.sn);
          capacityWh = deriveCapacityWh(quota);
          capabilities = deriveCapabilities(quota);
        } catch (error) {
          this.logger.warn({ sn: device.sn, error: (error as Error).message }, "quota probe failed during discovery");
        }
        return {
          vendorDeviceId: device.sn,
          vendor: "ecoflow",
          // The device-list endpoint does not return a model, so the user-assigned
          // name is used rather than guessing a model from the serial prefix.
          model: device.deviceName ?? "EcoFlow DELTA 2",
          name: device.deviceName ?? device.sn,
          capacityWh,
          capabilities,
        };
      }),
    );
  }

  async start(onTelemetry: TelemetryHandler): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status = "starting";

    const devices = await this.client.listDevices();
    if (!devices.length) {
      this.running = false;
      this.status = "stopped";
      throw new Error("No EcoFlow devices are bound to this account.");
    }

    const wanted = this.config.serialNumbers ?? [];
    const selected = wanted.length ? devices.filter(d => wanted.includes(d.sn)) : devices;
    if (!selected.length) {
      this.running = false;
      this.status = "stopped";
      throw new Error(`None of the configured serials are bound to this account. Bound: ${devices.map(d => d.sn).join(", ")}`);
    }

    this.targets.clear();
    for (const device of selected) this.applyDeviceListEntry(device);
    this.deviceListCheckedAt = Date.now();

    // Poll once immediately so a misconfiguration surfaces at startup, then on interval.
    await this.poll(onTelemetry);
    this.schedule(onTelemetry);
  }

  /** Serials this connector is collecting, in device-list order. */
  get serials(): string[] {
    return [...this.targets.keys()];
  }

  private applyDeviceListEntry(device: EcoFlowDeviceListEntry) {
    // Documented: "online: Device online or not 0: No, 1: Yes".
    this.targets.set(device.sn, device.online === undefined ? undefined : device.online === 1);
  }

  private schedule(onTelemetry: TelemetryHandler) {
    if (!this.running) return;
    // Back off on sustained failure so a wrong key does not hammer the API.
    const backoff = Math.min(this.consecutiveFailures, 5);
    const delay = this.pollIntervalMs * (backoff > 1 ? Math.min(2 ** (backoff - 1), 10) : 1);
    this.timer = setTimeout(() => {
      void this.poll(onTelemetry).finally(() => this.schedule(onTelemetry));
    }, delay);
  }

  private async refreshOnlineState() {
    const refreshMs = this.config.deviceListRefreshMs ?? DEFAULT_DEVICE_LIST_REFRESH_MS;
    if (Date.now() - this.deviceListCheckedAt < refreshMs) return;
    const devices = await this.client.listDevices();
    this.deviceListCheckedAt = Date.now();
    for (const sn of this.targets.keys()) {
      const device = devices.find(d => d.sn === sn);
      // A device that vanished from the list is treated as unknown, not offline.
      this.targets.set(sn, device?.online === undefined ? undefined : device.online === 1);
    }
  }

  private async poll(onTelemetry: TelemetryHandler): Promise<void> {
    if (!this.running || this.polling || !this.targets.size) return;
    this.polling = true;
    try {
      await this.refreshOnlineState();

      const offline: string[] = [];
      const failed: string[] = [];
      let delivered = 0;

      for (const [sn, online] of this.targets) {
        // A device that is known-offline reports stale quota values. Emitting them
        // would integrate stale power into real energy totals, so leave a genuine
        // gap instead — the integrator is gap-aware by design.
        if (online === false) { offline.push(sn); continue; }

        try {
          const quota = await this.client.getAllQuota(sn);
          const sample = mapDelta2Quota(quota, {
            deviceId: sn,
            observedAt: new Date(),
            online,
            includeRaw: this.config.includeRaw,
          });

          // EcoFlow serves the device's last reported state. When nothing has
          // changed the device simply has not reported again, so the sample is
          // marked as a repeat rather than passed off as a fresh measurement.
          const signature = telemetrySignature(sample);
          if (this.signatures.get(sn) === signature) sample.qualityFlags |= QUALITY_FLAGS.REPEATED_READING;
          this.signatures.set(sn, signature);

          await onTelemetry(sample);
          this.lastTelemetryAt = sample.observedAt;
          delivered++;
        } catch (error) {
          // One unreachable device must not stop the others from being recorded.
          failed.push(sn);
          this.logger.warn({ component: "ecoflow", sn, error: (error as Error).message }, "EcoFlow poll failed for device");
        }
      }

      if (delivered) {
        this.consecutiveFailures = 0;
        const notes = [
          offline.length ? `${offline.length} offline (${offline.join(", ")})` : "",
          failed.length ? `${failed.length} failed (${failed.join(", ")})` : "",
        ].filter(Boolean);
        this.status = notes.length ? "degraded" : "healthy";
        this.lastError = notes.length ? notes.join("; ") : undefined;
      } else {
        this.consecutiveFailures += 1;
        this.status = "degraded";
        this.lastError = offline.length && !failed.length
          ? `All devices reported offline by EcoFlow (${offline.join(", ")})`
          : `No device could be read (${[...offline, ...failed].join(", ") || "none reachable"})`;
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = (error as Error).message;
      this.status = "degraded";
      this.logger.warn(
        { component: "ecoflow", failures: this.consecutiveFailures, error: this.lastError },
        "EcoFlow poll failed",
      );
    } finally {
      this.polling = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.status = "stopped";
  }

  getHealth(): Health {
    return { status: this.status, lastTelemetryAt: this.lastTelemetryAt, error: this.lastError };
  }
}
