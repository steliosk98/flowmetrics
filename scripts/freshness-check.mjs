#!/usr/bin/env node
/**
 * Validates that battery telemetry is genuinely updating — with the EcoFlow
 * mobile app closed.
 *
 *   node scripts/freshness-check.mjs                       # last 10 minutes
 *   node scripts/freshness-check.mjs --minutes 30
 *   node scripts/freshness-check.mjs --url http://host:8503
 *
 * Reads only the public API, so it can be run from any machine on the tailnet.
 * Exits non-zero if the data looks stale, so it can be used in a cron or /loop.
 *
 * Why this exists: EcoFlow's HTTP endpoints serve the device's last *reported*
 * state. If the connector silently falls back from MQTT to polling, everything
 * still reports "healthy" while the numbers quietly stop moving. This checks the
 * measurements themselves.
 *
 * It judges two separate things and does not confuse them: whether samples are
 * still being written at the configured cadence, and whether the device's own
 * reports are still arriving unprompted. An idle battery on a dark night
 * legitimately reports very little, and that is not a fault.
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = (argOf("--url", process.env.FLOWMETRICS_URL || "http://localhost:8503")).replace(/\/+$/, "");
const MINUTES = Number(argOf("--minutes", "10"));

/**
 * Bit 16 = REPEATED_READING: the server sets it when a sample is byte-identical
 * to the previous one, i.e. the device had not reported anything new. Counting
 * samples *without* it is the authoritative measure of end-to-end delivery,
 * using the same definition the collector applied at ingest.
 */
const REPEATED_READING = 16;

async function json(path) {
  const response = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
  return response.json();
}

function human(seconds) {
  if (!Number.isFinite(seconds)) return "n/a";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${(seconds / 60).toFixed(1)}min`;
}

const to = new Date();
const from = new Date(to.getTime() - MINUTES * 60_000);

console.log(`FlowMetrics freshness check — ${BASE}`);
console.log(`Window: last ${MINUTES} min (${from.toLocaleTimeString()} to ${to.toLocaleTimeString()})`);
console.log("Run this with the EcoFlow mobile app CLOSED for the result to mean anything.\n");

let status;
try {
  status = await json("/api/v1/status");
} catch (error) {
  console.error(`Could not reach FlowMetrics: ${error.message}`);
  process.exit(2);
}

const transport = status.collector?.transport ?? "unknown";
console.log(`Collector : ${status.collector?.status} via ${transport} (mode ${status.mode})`);
if (status.collector?.error) console.log(`            note: ${status.collector.error}`);
if (transport === "poll") {
  console.log("            WARNING: polling EcoFlow's cached state, which updates only when the device reports.");
}
console.log(`Sampling  : every ${status.expectedIntervalSeconds}s\n`);

const devices = (await json("/api/v1/devices")).filter(d => !d.combined);
if (!devices.length) { console.error("No devices registered."); process.exit(2); }

let failures = 0;
let warnings = 0;

if (transport !== "mqtt") {
  console.log("FAIL: transport is not mqtt, so readings can only be as fresh as EcoFlow's cache.\n");
  failures++;
}

for (const device of devices) {
  const { points = [] } = await json(
    `/api/v1/history?device=${encodeURIComponent(device.id)}&from=${from.toISOString()}&to=${to.toISOString()}&maxPoints=5000`,
  );

  console.log(`${device.name}  (${device.vendorDeviceId})`);

  if (points.length < 2) {
    console.log(`  FAIL  only ${points.length} sample(s) recorded in the window\n`);
    failures++;
    continue;
  }

  const spanSeconds = (new Date(points.at(-1).observedAt) - new Date(points[0].observedAt)) / 1000;
  const cadence = spanSeconds / (points.length - 1);

  // Samples the device genuinely re-reported, as opposed to re-served repeats.
  const fresh = points.filter(p => !((p.qualityFlags ?? 0) & REPEATED_READING));
  const freshTimes = fresh.map(p => new Date(p.observedAt).getTime());

  let longestGap = 0;
  const marks = [new Date(points[0].observedAt).getTime(), ...freshTimes, new Date(points.at(-1).observedAt).getTime()];
  for (let i = 1; i < marks.length; i++) longestGap = Math.max(longestGap, (marks[i] - marks[i - 1]) / 1000);

  const ageSeconds = device.lastChangedAt ? (Date.now() - new Date(device.lastChangedAt).getTime()) / 1000 : Infinity;

  console.log(`  samples recorded    ${points.length} over ${human(spanSeconds)}  (every ${human(cadence)})`);
  console.log(`  fresh device reports ${fresh.length}  (${((fresh.length / points.length) * 100).toFixed(0)}% of samples carried new values)`);
  console.log(`  longest with no new report  ${human(longestGap)}`);
  console.log(`  last new report     ${human(ageSeconds)} ago`);

  // Two different things are being judged:
  //   plumbing  — are samples still being written at the configured cadence?
  //   delivery  — is the device's own data still reaching us unprompted?
  // A battery that is genuinely idle (dark, no load) legitimately reports little,
  // so a quiet spell is only suspicious when nothing arrives for a long time.
  const cadenceOk = cadence < status.expectedIntervalSeconds * 3;
  const deliveryOk = fresh.length > 0 && longestGap < 1800 && ageSeconds < 1800;

  if (!cadenceOk) {
    console.log(`  FAIL  samples are not being written at the ${status.expectedIntervalSeconds}s cadence\n`);
    failures++;
  } else if (!deliveryOk) {
    console.log(`  FAIL  no new device report for over 30 min — feed looks stuck\n`);
    failures++;
  } else {
    const quiet = longestGap > 600;
    console.log(`  PASS  recording at cadence, device reporting unprompted${quiet ? " (battery mostly idle in this window)" : ""}\n`);
    if (quiet) warnings++;
  }
}

if (failures) {
  console.log(`RESULT: FAIL — ${failures} check(s) failed.`);
  console.log("Confirm ECOFLOW_TRANSPORT=mqtt and look for MQTT errors in the logs.");
  process.exit(1);
}
console.log(`RESULT: PASS — all ${devices.length} device(s) updating with the app closed.`);
if (warnings) {
  console.log("Note: long quiet spells seen. That is normal for an idle battery (no sun, steady load);");
  console.log("what matters is that new reports still arrive on their own. Re-run during charging to see a higher rate.");
}
