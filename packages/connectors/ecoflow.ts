import { z } from "zod";
import mqtt, { type MqttClient } from "mqtt";
import type { DiscoveredDevice, EnergyConnector, TelemetryHandler } from "../core/index";
import { DEFAULT_ECOFLOW_HOST, EcoFlowClient, type EcoFlowDeviceListEntry } from "./ecoflow-client";
import { deriveCapabilities, deriveCapacityWh, mapDelta2Quota, QUALITY_FLAGS, telemetrySignature } from "./ecoflow-delta2-mapping";
import { applyMqttReport, parseStatusReport, quotaTopic, statusTopic } from "./ecoflow-mqtt";

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
  /**
   * "mqtt" subscribes to the device's own live reports; "poll" reads the HTTP
   * cache. MQTT falls back to polling automatically if the broker is unreachable.
   */
  transport: z.enum(["mqtt", "poll"]).optional(),
  /**
   * How often a sample is recorded from the live MQTT state. The device reports
   * roughly once a second; storing every message would be ~86k rows per battery
   * per day, so readings are sampled at this cadence instead.
   */
  sampleIntervalMs: z.number().int().min(1_000).max(300_000).optional(),
});

export type EcoFlowConfiguration = z.infer<typeof ecoFlowConfigurationSchema>;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_DEVICE_LIST_REFRESH_MS = 300_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

/** Distinct client id per process; a collision would disconnect the other client. */
function randomClientSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Periodic HTTP re-seed, so a missed delta cannot drift the state indefinitely. */
const MQTT_RESYNC_MS = 900_000;

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

  // --- MQTT transport ---
  private mqttClient?: MqttClient;
  /** Serial -> live quota state, seeded from HTTP then updated by MQTT deltas. */
  private mqttState = new Map<string, Record<string, unknown>>();
  private mqttSampler?: ReturnType<typeof setInterval>;
  private mqttResync?: ReturnType<typeof setInterval>;
  private mqttConnected = false;
  private certificateAccount?: string;
  private onTelemetry?: TelemetryHandler;
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

    this.onTelemetry = onTelemetry;

    // Seed from HTTP either way: MQTT sends only changed fields, so a full
    // snapshot is needed before any delta means anything.
    await this.poll(onTelemetry);

    if ((this.config.transport ?? "mqtt") === "mqtt") {
      try {
        await this.startMqtt(onTelemetry);
        return;
      } catch (error) {
        this.logger.warn(
          { component: "ecoflow", error: (error as Error).message },
          "MQTT unavailable; falling back to HTTP polling (data will be as stale as EcoFlow's cache)",
        );
      }
    }

    this.schedule(onTelemetry);
  }

  /**
   * Subscribes to the devices' own report stream.
   *
   * The HTTP endpoints serve the last state the device reported to EcoFlow, which
   * for an idle DELTA 2 can be tens of minutes old. Over MQTT the same device
   * publishes roughly once a second with no app open, so this is the only way to
   * record what the battery is actually doing.
   */
  private async startMqtt(onTelemetry: TelemetryHandler): Promise<void> {
    const certification = await this.client.getMqttCertification();
    this.certificateAccount = certification.certificateAccount;

    const url = `${certification.protocol}://${certification.url}:${certification.port}`;
    const client = mqtt.connect(url, {
      username: certification.certificateAccount,
      password: certification.certificatePassword,
      clientId: `flowmetrics-${randomClientSuffix()}`,
      protocolVersion: 5,
      reconnectPeriod: 5_000,
      connectTimeout: 15_000,
    });
    this.mqttClient = client;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MQTT connect timed out")), 20_000);
      client.once("connect", () => { clearTimeout(timer); resolve(); });
      client.once("error", error => { clearTimeout(timer); reject(error); });
    });

    this.mqttConnected = true;
    this.status = "healthy";
    this.lastError = undefined;

    client.on("connect", () => {
      this.mqttConnected = true;
      for (const sn of this.targets.keys()) this.subscribeDevice(client, sn);
    });
    client.on("reconnect", () => this.logger.info({ component: "ecoflow" }, "MQTT reconnecting"));
    client.on("close", () => { this.mqttConnected = false; });
    client.on("error", error => {
      this.lastError = (error as Error).message;
      this.status = "degraded";
    });
    client.on("message", (topic, payload) => this.handleMqttMessage(topic, payload));

    for (const sn of this.targets.keys()) this.subscribeDevice(client, sn);

    // Record from the live state on a fixed cadence, so energy integration sees
    // evenly spaced samples rather than one row per MQTT message.
    const sampleMs = this.config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.mqttSampler = setInterval(() => void this.emitFromState(onTelemetry), sampleMs);

    // A dropped delta would otherwise persist in the merged state forever.
    this.mqttResync = setInterval(() => void this.resyncFromHttp(), MQTT_RESYNC_MS);

    this.logger.info(
      { component: "ecoflow", devices: this.targets.size, sampleIntervalMs: sampleMs },
      "MQTT transport connected",
    );
  }

  private subscribeDevice(client: MqttClient, sn: string) {
    const account = this.certificateAccount;
    if (!account) return;
    for (const topic of [quotaTopic(account, sn), statusTopic(account, sn)]) {
      client.subscribe(topic, { qos: 0 }, error => {
        if (error) this.logger.warn({ component: "ecoflow", topic, error: error.message }, "MQTT subscribe failed");
      });
    }
  }

  private handleMqttMessage(topic: string, payload: Buffer) {
    const parts = topic.split("/");
    const sn = parts[3];
    const kind = parts[4];
    if (!sn || !this.targets.has(sn)) return;

    let json: unknown;
    try { json = JSON.parse(payload.toString()); } catch { return; }

    if (kind === "status") {
      const online = parseStatusReport(json);
      if (online !== undefined) this.targets.set(sn, online);
      return;
    }

    const state = this.mqttState.get(sn) ?? {};
    if (applyMqttReport(state, json)) this.mqttState.set(sn, state);
  }

  /** Records the current merged state for every device as one sample each. */
  private async emitFromState(onTelemetry: TelemetryHandler) {
    for (const [sn, online] of this.targets) {
      // A device that is known-offline is not measuring; leave a real gap.
      if (online === false) continue;
      const state = this.mqttState.get(sn);
      if (!state || !Object.keys(state).length) continue;

      try {
        const sample = mapDelta2Quota(state, {
          deviceId: sn,
          observedAt: new Date(),
          online,
          includeRaw: this.config.includeRaw,
        });
        const signature = telemetrySignature(sample);
        if (this.signatures.get(sn) === signature) sample.qualityFlags |= QUALITY_FLAGS.REPEATED_READING;
        this.signatures.set(sn, signature);

        await onTelemetry(sample);
        this.lastTelemetryAt = sample.observedAt;
        this.status = this.mqttConnected ? "healthy" : "degraded";
      } catch (error) {
        this.logger.warn({ component: "ecoflow", sn, error: (error as Error).message }, "failed to record MQTT sample");
      }
    }
  }

  /** Re-reads the full snapshot over HTTP so the merged state cannot drift. */
  private async resyncFromHttp() {
    for (const sn of this.targets.keys()) {
      try {
        const quota = await this.client.getAllQuota(sn);
        // HTTP is authoritative for fields MQTT has not sent recently, but any
        // field MQTT has already delivered is fresher, so deltas win.
        const state = this.mqttState.get(sn) ?? {};
        this.mqttState.set(sn, { ...quota, ...state });
      } catch (error) {
        this.logger.warn({ component: "ecoflow", sn, error: (error as Error).message }, "MQTT resync failed");
      }
    }
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
          // Seed the MQTT baseline; deltas are merged on top of this.
          this.mqttState.set(sn, { ...quota });
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
    if (this.mqttSampler) clearInterval(this.mqttSampler);
    if (this.mqttResync) clearInterval(this.mqttResync);
    this.timer = undefined;
    this.mqttSampler = undefined;
    this.mqttResync = undefined;
    if (this.mqttClient) {
      await new Promise<void>(resolve => this.mqttClient?.end(true, {}, () => resolve()));
      this.mqttClient = undefined;
    }
    this.mqttConnected = false;
    this.status = "stopped";
  }

  /** Which transport is actually carrying data right now. */
  get activeTransport(): "mqtt" | "poll" {
    return this.mqttClient && this.mqttConnected ? "mqtt" : "poll";
  }

  getHealth(): Health {
    return { status: this.status, lastTelemetryAt: this.lastTelemetryAt, error: this.lastError };
  }
}
