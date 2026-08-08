import { z } from "zod";
import { signRequest, type EcoFlowCredentials } from "./ecoflow-signing";

/**
 * Thin HTTP client for the EcoFlow IoT Open Platform.
 *
 * Every endpoint, method, header and response shape here is taken from the
 * official developer documentation. Nothing is inferred.
 *
 *   GET  /iot-open/sign/device/list        bound device list
 *   GET  /iot-open/sign/device/quota/all   every quota value for one device
 *   GET  /iot-open/sign/certification      MQTT credentials (not used for polling)
 */

/** Documented host. Overridable because EcoFlow operates regional endpoints. */
export const DEFAULT_ECOFLOW_HOST = "https://api.ecoflow.com";

const deviceListSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  data: z
    .array(
      z.object({
        sn: z.string(),
        deviceName: z.string().optional(),
        online: z.number().optional(),
      }),
    )
    .nullish(),
});

const quotaAllSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  // Quota values are documented as ints, but the Delta Pro example in the docs
  // returns them as strings, so accept both and coerce at the mapping layer.
  data: z.record(z.string(), z.unknown()).nullish(),
});

const certificationSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  data: z
    .object({
      certificateAccount: z.string(),
      certificatePassword: z.string(),
      url: z.string(),
      port: z.string(),
      protocol: z.string(),
    })
    .nullish(),
});

export type EcoFlowDeviceListEntry = NonNullable<z.infer<typeof deviceListSchema>["data"]>[number];
export type EcoFlowQuota = Record<string, unknown>;

export class EcoFlowApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "EcoFlowApiError";
  }
}

export interface EcoFlowClientOptions {
  host?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EcoFlowClient {
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly credentials: EcoFlowCredentials,
    options: EcoFlowClientOptions = {},
  ) {
    this.host = (options.host ?? DEFAULT_ECOFLOW_HOST).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Signed GET. Query parameters are both sent on the URL and fed to the signer,
   * per step 7 of the documented algorithm (no JSON content-type => sign the
   * query string).
   */
  private async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const headers = signRequest(params, this.credentials);
    const url = new URL(this.host + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method: "GET", headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new EcoFlowApiError(`EcoFlow request to ${path} timed out after ${this.timeoutMs}ms`);
      throw new EcoFlowApiError(`EcoFlow request to ${path} failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new EcoFlowApiError(`EcoFlow ${path} returned HTTP ${response.status}`, undefined, response.status);
    }
    return response.json();
  }

  /** Documented: code "0" means success; anything else is an error with a message. */
  private unwrap<T>(parsed: { code: string; message?: string; data?: T | null }, path: string): T {
    if (parsed.code !== "0") {
      throw new EcoFlowApiError(
        `EcoFlow ${path} rejected the request: ${parsed.message ?? "no message"} (code ${parsed.code})`,
        parsed.code,
      );
    }
    if (parsed.data == null) {
      throw new EcoFlowApiError(`EcoFlow ${path} returned success with no data`, parsed.code);
    }
    return parsed.data;
  }

  /** Devices bound to this account. Shared devices are documented as excluded. */
  async listDevices(): Promise<EcoFlowDeviceListEntry[]> {
    const path = "/iot-open/sign/device/list";
    const parsed = deviceListSchema.parse(await this.get(path));
    // An account with no bound devices legitimately returns an empty list.
    if (parsed.code === "0" && parsed.data == null) return [];
    return this.unwrap(parsed, path);
  }

  /** Every quota key/value the device currently reports. */
  async getAllQuota(sn: string): Promise<EcoFlowQuota> {
    const path = "/iot-open/sign/device/quota/all";
    const parsed = quotaAllSchema.parse(await this.get(path, { sn }));
    return this.unwrap(parsed, path);
  }

  /**
   * MQTT credentials. Not used by the polling collector, but exposed so the
   * push-based transport can be added without re-deriving the auth flow.
   */
  async getMqttCertification() {
    const path = "/iot-open/sign/certification";
    const parsed = certificationSchema.parse(await this.get(path));
    return this.unwrap(parsed, path);
  }
}
