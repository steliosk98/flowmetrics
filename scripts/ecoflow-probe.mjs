#!/usr/bin/env node
/**
 * Verifies EcoFlow IoT Open Platform credentials and shows what your hardware
 * actually reports, without touching the database or starting the collector.
 *
 *   node scripts/ecoflow-probe.mjs                 # read .env
 *   node scripts/ecoflow-probe.mjs --raw           # also print every quota key
 *   node scripts/ecoflow-probe.mjs --sn R351...    # probe one specific device
 *
 * Nothing is written anywhere and no credential is printed.
 */
import { createHmac, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "https://api.ecoflow.com";

async function loadEnvFile(path = ".env") {
  try {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch {
    // No .env is fine when the variables are already exported.
  }
}

/**
 * This file deliberately re-implements signing so it runs with plain `node`,
 * with no build step and no node_modules. ecoflow-probe.test.ts imports these
 * two functions and checks them against EcoFlow's published test vector, so the
 * copy cannot silently drift from packages/connectors/ecoflow-signing.ts.
 */
export function flatten(value, prefix = "") {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => flatten(item, `${prefix}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  }
  return [`${prefix}=${String(value)}`];
}

export function signedHeaders(params, accessKey, secretKey, overrides = {}) {
  const nonce = overrides.nonce ?? String(randomInt(100_000, 1_000_000));
  const timestamp = overrides.timestamp ?? String(Date.now());
  const sorted = flatten(params).sort();
  const suffix = `accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const base = sorted.length ? `${sorted.join("&")}&${suffix}` : suffix;
  const sign = createHmac("sha256", secretKey).update(base, "utf8").digest("hex");
  return { accessKey, nonce, timestamp, sign };
}

async function get(host, path, params, accessKey, secretKey) {
  const url = new URL(host.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: signedHeaders(params, accessKey, secretKey) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
  const body = await response.json();
  if (body.code !== "0") throw new Error(`${path} rejected: ${body.message ?? "no message"} (code ${body.code})`);
  return body.data;
}

const INTERESTING = [
  ["pd.soc", "State of charge (%)"],
  ["bms_emsStatus.f32LcdShowSoc", "State of charge, decimal (%)"],
  ["pd.wattsInSum", "Total input (W)"],
  ["pd.wattsOutSum", "Total output (W)"],
  ["pd.pv1ChargeWatts", "PV1 input (W)"],
  ["pd.pv1ChargeType", "PV1 source (0 none, 1 adapter, 2 solar)"],
  ["pd.pv2ChargeWatts", "PV2 input (W)"],
  ["pd.pv2ChargeType", "PV2 source (0 none, 1 adapter, 2 solar)"],
  ["mppt.inWatts", "MPPT PV1 input (W)"],
  ["inv.inputWatts", "AC/grid charge power (W)"],
  ["inv.outputWatts", "AC output (W)"],
  ["inv.acInVol", "AC input voltage (mV)"],
  ["bms_bmsStatus.inputWatts", "Battery charge power (W)"],
  ["bms_bmsStatus.outputWatts", "Battery discharge power (W)"],
  ["bms_bmsStatus.temp", "Battery temperature (C)"],
  ["bms_bmsStatus.soh", "Battery health (%)"],
  ["bms_bmsStatus.fullCap", "Full capacity (mAh)"],
  ["bms_bmsStatus.vol", "Pack voltage (mV)"],
];

async function main() {
  await loadEnvFile();

  const args = process.argv.slice(2);
  const wantRaw = args.includes("--raw");
  const snArg = args.includes("--sn") ? args[args.indexOf("--sn") + 1] : undefined;

  const accessKey = process.env.ECOFLOW_ACCESS_KEY?.trim();
  const secretKey = process.env.ECOFLOW_SECRET_KEY?.trim();
  const host = process.env.ECOFLOW_HOST?.trim() || DEFAULT_HOST;

  if (!accessKey || !secretKey) {
    console.error("ECOFLOW_ACCESS_KEY and ECOFLOW_SECRET_KEY must be set (in .env or the environment).");
    console.error("Create them at https://developer-eu.ecoflow.com -> sign in -> IoT Developer Platform.");
    process.exit(2);
  }

  console.log(`Host: ${host}`);
  console.log(`Access key: ${accessKey.slice(0, 4)}...${accessKey.slice(-2)} (${accessKey.length} chars)\n`);

  let devices;
  try {
    devices = await get(host, "/iot-open/sign/device/list", undefined, accessKey, secretKey);
  } catch (error) {
    console.error(`Credential check FAILED: ${error.message}`);
    console.error("\nA signature error usually means the secret key is wrong or has a stray space.");
    console.error("An empty device list means the account has no bound devices.");
    process.exit(1);
  }

  if (!devices?.length) {
    console.error("Credentials work, but no devices are bound to this EcoFlow account.");
    console.error("Bind the battery in the EcoFlow mobile app with the same account used for the developer portal.");
    process.exit(1);
  }

  console.log(`Credentials OK. ${devices.length} bound device(s):`);
  for (const device of devices) {
    console.log(`  ${device.sn}  ${device.deviceName ?? "(unnamed)"}  ${device.online === 1 ? "online" : "OFFLINE"}`);
  }

  const target = snArg ?? devices[0].sn;
  console.log(`\nReading all quota for ${target} ...\n`);

  const quota = await get(host, "/iot-open/sign/device/quota/all", { sn: target }, accessKey, secretKey);
  const keys = Object.keys(quota);
  console.log(`${keys.length} quota keys returned.\n`);

  console.log("Fields FlowMetrics maps:");
  let missing = 0;
  for (const [key, label] of INTERESTING) {
    const present = key in quota;
    if (!present) missing++;
    console.log(`  ${present ? "OK  " : "--  "} ${key.padEnd(32)} ${String(present ? quota[key] : "not reported").padEnd(14)} ${label}`);
  }

  if (missing) {
    console.log(`\n${missing} of ${INTERESTING.length} fields are not reported by this model.`);
    console.log("FlowMetrics stores those as NULL rather than zero. Re-run with --raw to see every key it does report.");
  }

  if (wantRaw) {
    console.log("\nAll quota keys:");
    for (const key of keys.sort()) console.log(`  ${key.padEnd(40)} ${JSON.stringify(quota[key])}`);
  }

  console.log("\nSet these in .env to start recording:");
  console.log("  CONNECTOR=ecoflow");
  console.log(`  ECOFLOW_SERIAL_NUMBER=${target}`);
}

// Run only when invoked directly, so the signing helpers stay importable by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
