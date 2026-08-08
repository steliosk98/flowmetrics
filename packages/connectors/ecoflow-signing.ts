import { createHmac, randomInt } from "node:crypto";

/**
 * EcoFlow IoT Open Platform request signing.
 *
 * Implemented verbatim from the official developer documentation
 * (https://developer-eu.ecoflow.com -> General User Manual -> General Information,
 * section "HTTP access steps"). The documented worked example is exercised as a
 * contract test in ecoflow-signing.test.ts, so any drift from the published
 * algorithm fails the build rather than failing silently against live hardware.
 */

export interface EcoFlowCredentials {
  accessKey: string;
  secretKey: string;
}

export interface SignedRequestHeaders extends Record<string, string> {
  accessKey: string;
  nonce: string;
  timestamp: string;
  sign: string;
}

/**
 * Step 2 of the documented algorithm: expand a nested payload into flat
 * `key=value` pairs.
 *
 *   { name: "demo1", ids: [1,2,3], deviceInfo: { id: 1 }, deviceList: [{id:1},{id:2}] }
 *
 * becomes
 *
 *   name=demo1, ids[0]=1, ids[1]=2, ids[2]=3, deviceInfo.id=1,
 *   deviceList[0].id=1, deviceList[1].id=2
 */
export function flattenParams(value: unknown, prefix = ""): string[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenParams(item, `${prefix}[${index}]`));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      flattenParams(item, prefix ? `${prefix}.${key}` : key),
    );
  }

  return [`${prefix}=${String(value)}`];
}

/**
 * Steps 1-3: flatten, sort the flattened pairs by ASCII value, join with `&`,
 * then append the credential triple in the documented fixed order.
 */
export function buildSignatureBase(
  params: unknown,
  credentials: Pick<EcoFlowCredentials, "accessKey">,
  nonce: string,
  timestamp: string,
): string {
  const sorted = flattenParams(params).sort();
  const suffix = `accessKey=${credentials.accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  // Requests without parameters (device/list, certification) sign the suffix alone,
  // with no leading separator.
  return sorted.length ? `${sorted.join("&")}&${suffix}` : suffix;
}

/** Steps 4-5: HMAC-SHA256 keyed with the secret, rendered as a lowercase hex string. */
export function signPayload(base: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(base, "utf8").digest("hex");
}

/** Documented as a random 6-digit number. */
export function createNonce(): string {
  return String(randomInt(100_000, 1_000_000));
}

/** Step 6: the four headers every signed request carries. */
export function signRequest(
  params: unknown,
  credentials: EcoFlowCredentials,
  options: { nonce?: string; timestamp?: string } = {},
): SignedRequestHeaders {
  const nonce = options.nonce ?? createNonce();
  const timestamp = options.timestamp ?? String(Date.now());
  const base = buildSignatureBase(params, credentials, nonce, timestamp);
  return {
    accessKey: credentials.accessKey,
    nonce,
    timestamp,
    sign: signPayload(base, credentials.secretKey),
  };
}
