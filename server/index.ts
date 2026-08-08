import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { combineDailySeries, combineSamples, combineSeries, COMBINED_DEVICE_ID, demoSampleAt, EventDetector, type NormalizedTelemetry } from "../packages/core/index";
import { ensureDevice, persistTelemetry, pool, runMigrations } from "./db";
import { getSamples, rebuildDay, rowToSample } from "./analytics";
import { registerAuth } from "./auth";
import { buildConnector } from "./connector";
import { QUALITY_FLAGS } from "../packages/connectors/ecoflow-delta2-mapping";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.secret", "*.accessKey", "*.secretKey", "*.certificatePassword"] } });
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });

const built = buildConnector(process.env, app.log);
const { connector, mode, expectedIntervalSeconds } = built;
const isDemo = mode === "demo";

/** One registered device. Several EcoFlow batteries can be bound to one account. */
interface TrackedDevice {
  /** Internal devices.id */
  id: string;
  /** Vendor serial the connector reports */
  vendorDeviceId: string;
  name: string;
  model: string;
  capacityWh?: number;
  /** Event detection is a per-device state machine; sharing one across devices
   *  would interleave their transitions and emit nonsense. */
  detector: EventDetector;
  latestSample?: NormalizedTelemetry;
  /** When the device last reported something different, as opposed to when we
   *  last polled. EcoFlow re-serves an idle device's previous report. */
  lastChangedAt?: Date;
}

let databaseReady = false;
let collectorError: string | undefined;

const devices = new Map<string, TrackedDevice>();          // internal id -> device
const bySerial = new Map<string, TrackedDevice>();         // vendor serial -> device

function deviceList(): TrackedDevice[] { return [...devices.values()]; }
function defaultDevice(): TrackedDevice | undefined { return deviceList()[0]; }

/** Resolves the ?device= query parameter, falling back to the first device. */
function resolveDevice(requested?: string): TrackedDevice | undefined {
  if (requested) return devices.get(requested) ?? bySerial.get(requested);
  return defaultDevice();
}

function track(device: Omit<TrackedDevice, "detector">) {
  const existing = devices.get(device.id);
  const tracked: TrackedDevice = existing ?? { ...device, detector: new EventDetector() };
  Object.assign(tracked, device);
  devices.set(tracked.id, tracked);
  bySerial.set(tracked.vendorDeviceId, tracked);
  return tracked;
}

try { await runMigrations(); databaseReady = true; } catch (error) { app.log.warn({ component: "db", error }, "database unavailable; health remains degraded"); }
if (databaseReady) await registerAuth(app);

// Subscribers to the SSE feed. Samples are pushed as they arrive rather than
// re-synthesised on a timer, so the live view shows what was actually measured.
// Each client may pin itself to one device with ?device=.
const liveClients = new Set<{ res: ServerResponse; deviceId?: string }>();
function broadcast(device: TrackedDevice, sample: NormalizedTelemetry) {
  const frame = `event: telemetry\ndata: ${JSON.stringify({ ...sample, deviceId: device.id })}\n\n`;
  for (const client of liveClients) {
    if (client.deviceId && client.deviceId !== device.id) continue;
    try { client.res.write(frame); } catch { liveClients.delete(client); }
  }
}

async function handleSample(sample: NormalizedTelemetry) {
  // The connector reports the vendor serial; storage is keyed by the internal device row.
  const device = bySerial.get(sample.deviceId) ?? defaultDevice();
  if (!device) return;
  sample.deviceId = device.id;
  if (!(sample.qualityFlags & QUALITY_FLAGS.REPEATED_READING)) device.lastChangedAt = sample.observedAt;
  device.latestSample = sample;
  broadcast(device, sample);
  if (!databaseReady) return;
  await persistTelemetry(device.id, sample);
  for (const event of device.detector.process(sample)) {
    await pool.query(`INSERT INTO device_events (device_id,event_type,started_at,severity,value_start) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [device.id, event.type, event.at, event.severity, event.value]);
  }
}

/**
 * Registers every device the connector can see and starts collection. A collector
 * that cannot reach its vendor API must not stop the service from booting: the
 * dashboard still serves recorded history and reports the failure via /api/v1/health.
 */
async function startCollection() {
  if (!connector) { app.log.info({ component: "collector" }, "collector disabled"); return; }

  let registrations = [built.registration];

  if (mode === "ecoflow") {
    // Resolve real serials, names and pack capacities before any device row is written.
    const discovered = await connector.discoverDevices();
    if (!discovered.length) throw new Error("No EcoFlow devices are bound to this account.");
    const single = discovered.length === 1;
    registrations = discovered.map(device => ({
      ...built.registration,
      vendorDeviceId: device.vendorDeviceId,
      // The device-list endpoint returns no model, so the connector falls back to
      // the user-assigned device name. ECOFLOW_DEVICE_MODEL is an explicit
      // statement of fact from the operator and applies to every device.
      model: process.env.ECOFLOW_DEVICE_MODEL?.trim() || device.model,
      // Renaming only makes sense when there is exactly one device to rename.
      name: (single ? process.env.ECOFLOW_DEVICE_NAME?.trim() : undefined) || device.name,
      capacityWh: device.capacityWh,
    }));
    app.log.info({ component: "collector", devices: discovered.map(d => ({ sn: d.vendorDeviceId, name: d.name, capacityWh: d.capacityWh })) }, "EcoFlow devices discovered");
  }

  for (const registration of registrations) {
    const id = databaseReady ? await ensureDevice(registration) : registration.vendorDeviceId;
    track({ id, vendorDeviceId: registration.vendorDeviceId, name: registration.name, model: registration.model, capacityWh: registration.capacityWh });
  }

  await connector.start(handleSample);
  app.log.info({ component: "collector", mode, deviceCount: devices.size, intervalSeconds: expectedIntervalSeconds }, "collector started");
}

try {
  await startCollection();
} catch (error) {
  collectorError = (error as Error).message;
  app.log.error({ component: "collector", mode, error: collectorError }, "collector failed to start");
  // Still register a device row so the dashboard has something coherent to show.
  if (!devices.size) {
    try {
      const id = databaseReady ? await ensureDevice(built.registration) : built.registration.vendorDeviceId;
      track({ id, vendorDeviceId: built.registration.vendorDeviceId, name: built.registration.name, model: built.registration.model });
    } catch { /* nothing to show; endpoints degrade to empty */ }
  }
}

/** True when the caller asked for the combined site view. */
const wantsCombined = (device?: string) => device === COMBINED_DEVICE_ID;
const capacityOf = (id: string) => devices.get(id)?.capacityWh;
/** Every device id, for fan-out queries. */
const allDeviceIds = () => deviceList().map(d => d.id);

/**
 * Which transport is actually carrying data. MQTT falls back to HTTP polling on
 * failure, and that fallback still reports "healthy" while quietly serving
 * EcoFlow's stale cache — so it has to be visible.
 */
function activeTransport(): string | undefined {
  const candidate = connector as unknown as { activeTransport?: string };
  return typeof candidate?.activeTransport === "string" ? candidate.activeTransport : undefined;
}

function collectorHealth() {
  const health = connector?.getHealth() ?? { status: "stopped" as const, error: "collector disabled" };
  const transport = activeTransport();
  const withTransport = transport ? { ...health, transport } : health;
  return collectorError ? { ...withTransport, status: "degraded" as const, error: collectorError } : withTransport;
}

app.get("/api/v1/health", async (_request, reply) => reply.code(databaseReady ? 200 : 503).send({ healthy: databaseReady, database: databaseReady ? "reachable" : "unavailable", migrations: databaseReady ? "current" : "unknown", collector: collectorHealth(), deviceCount: devices.size, timestamp: new Date().toISOString() }));
app.get("/api/v1/status", async () => ({ version: "0.1.0", mode, databaseReady, rawPayloads: process.env.STORE_RAW_PAYLOADS === "true", expectedIntervalSeconds, collector: collectorHealth(), deviceCount: devices.size }));

/** Every device this instance records, for the dashboard's device switcher. */
app.get("/api/v1/devices", async () => {
  const list = deviceList().map(device => ({
    id: device.id,
    vendorDeviceId: device.vendorDeviceId,
    name: device.name,
    model: device.model,
    capacityWh: device.capacityWh ?? null,
    online: device.latestSample?.deviceOnline ?? null,
    batterySocPct: device.latestSample?.batterySocPct ?? null,
    lastObservedAt: device.latestSample?.observedAt ?? null,
    // When the device itself last reported a change. EcoFlow re-serves the last
    // report for an idle battery, so this can be far older than lastObservedAt.
    lastChangedAt: device.lastChangedAt ?? null,
    combined: false,
  }));

  // A combined entry only means something with more than one battery.
  if (list.length > 1) {
    const combined = combineSamples(
      deviceList().map(d => d.latestSample).filter((s): s is NormalizedTelemetry => s !== undefined),
      capacityOf,
      list.length,
    );
    const capacities = deviceList().map(d => d.capacityWh).filter((c): c is number => c !== undefined);
    list.push({
      id: COMBINED_DEVICE_ID,
      vendorDeviceId: COMBINED_DEVICE_ID,
      name: "All batteries",
      model: `${list.length} batteries combined`,
      capacityWh: capacities.length === list.length ? capacities.reduce((a, b) => a + b, 0) : null,
      online: combined?.deviceOnline ?? null,
      batterySocPct: combined?.batterySocPct ?? null,
      lastObservedAt: combined?.observedAt ?? null,
      lastChangedAt: deviceList().reduce<Date | null>((oldest, d) => {
        if (!d.lastChangedAt) return oldest;
        return !oldest || d.lastChangedAt < oldest ? d.lastChangedAt : oldest;
      }, null),
      combined: true,
    });
  }
  return list;
});

type DeviceQuery = { device?: string };

app.get<{ Querystring: DeviceQuery }>("/api/v1/current", async request => {
  if (wantsCombined(request.query.device)) {
    const latest = deviceList().map(d => d.latestSample).filter((s): s is NormalizedTelemetry => s !== undefined);
    return combineSamples(latest, capacityOf, devices.size) ?? null;
  }
  const device = resolveDevice(request.query.device);
  if (!device) return isDemo ? demoSampleAt(new Date()) : null;
  if (databaseReady) {
    const result = await pool.query("SELECT * FROM telemetry_samples WHERE device_id=$1 ORDER BY observed_at DESC LIMIT 1", [device.id]);
    // Normalised, so this endpoint and the /live stream always agree on shape.
    if (result.rows[0]) return rowToSample(result.rows[0]);
  }
  if (device.latestSample) return device.latestSample;
  // Only synthesise a reading when this instance is explicitly a demo.
  return isDemo ? demoSampleAt(new Date()) : null;
});

app.get<{ Querystring: DeviceQuery & { from?: string; to?: string; maxPoints?: string } }>("/api/v1/history", async request => {
  const to = request.query.to ? new Date(request.query.to) : new Date(); const from = request.query.from ? new Date(request.query.from) : new Date(to.getTime()-86_400_000);
  const maxPoints = Math.min(5000, Math.max(100, Number(request.query.maxPoints ?? 3000)));

  if (wantsCombined(request.query.device) && databaseReady) {
    const series = await Promise.all(allDeviceIds().map(id => getSamples(id, from, to, maxPoints)));
    // Buckets are the poll interval, so batteries polled seconds apart line up.
    return { from, to, points: combineSeries(series, capacityOf, expectedIntervalSeconds) };
  }

  const device = resolveDevice(request.query.device);
  if (!databaseReady || !device) return { from, to, coveragePct: isDemo ? 100 : 0, points: isDemo ? Array.from({ length: 288 },(_,i)=>demoSampleAt(new Date(from.getTime()+i*300_000))) : [] };
  const points = await getSamples(device.id,from,to,maxPoints); return { from,to,points };
});

app.get<{ Querystring: DeviceQuery }>("/api/v1/summary", async request => {
  if (wantsCombined(request.query.device) && databaseReady) {
    const ids = allDeviceIds();
    await Promise.all(ids.map(id => rebuildDay(id, new Date(), expectedIntervalSeconds)));
    const rows = await pool.query("SELECT * FROM energy_daily WHERE device_id = ANY($1) AND local_date = (SELECT max(local_date) FROM energy_daily WHERE device_id = ANY($1))", [ids]);
    return combineDailySeries(rows.rows)[0] ?? {};
  }
  const device = resolveDevice(request.query.device);
  if (!databaseReady || !device) return { coveragePct: isDemo ? 100 : 0, mode };
  await rebuildDay(device.id,new Date(),expectedIntervalSeconds);
  const result=await pool.query("SELECT * FROM energy_daily WHERE device_id=$1 ORDER BY local_date DESC LIMIT 1",[device.id]);
  return result.rows[0] ?? {};
});

app.get<{ Querystring: DeviceQuery }>("/api/v1/daily", async request => {
  if (wantsCombined(request.query.device) && databaseReady) {
    const rows = await pool.query("SELECT * FROM energy_daily WHERE device_id = ANY($1) ORDER BY local_date DESC LIMIT 732", [allDeviceIds()]);
    return combineDailySeries(rows.rows).slice(0, 366);
  }
  const device = resolveDevice(request.query.device);
  return databaseReady && device ? (await pool.query("SELECT * FROM energy_daily WHERE device_id=$1 ORDER BY local_date DESC LIMIT 366",[device.id])).rows : [];
});

app.get<{ Querystring: DeviceQuery }>("/api/v1/events", async request => {
  if (wantsCombined(request.query.device) && databaseReady) {
    // Events stay per battery — merged into one timeline, labelled by device.
    const rows = await pool.query("SELECT e.*, d.name AS device_name FROM device_events e JOIN devices d ON d.id=e.device_id WHERE e.device_id = ANY($1) ORDER BY e.started_at DESC LIMIT 500", [allDeviceIds()]);
    return rows.rows;
  }
  const device = resolveDevice(request.query.device);
  return databaseReady && device ? (await pool.query("SELECT * FROM device_events WHERE device_id=$1 ORDER BY started_at DESC LIMIT 500",[device.id])).rows : [];
});

app.get<{ Querystring: DeviceQuery }>("/api/v1/stats", async (request, reply) => {
  const combined = wantsCombined(request.query.device);
  const device = combined ? undefined : resolveDevice(request.query.device);
  if (!databaseReady || (!device && !combined)) return reply.code(503).send({ error: "database unavailable" });
  const ids = combined ? allDeviceIds() : [(device as TrackedDevice).id];
  const samples = await pool.query<{ count: string; first: string | null; last: string | null }>("SELECT count(*)::text AS count, min(observed_at) AS first, max(observed_at) AS last FROM telemetry_samples WHERE device_id = ANY($1)", [ids]);
  const coverage = await pool.query<{ coverage: string | null; days: string }>("SELECT avg(coverage_pct)::text AS coverage, count(DISTINCT local_date)::text AS days FROM energy_daily WHERE device_id = ANY($1)", [ids]);
  const size = await pool.query<{ size: string }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS size");
  const events = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM device_events WHERE device_id = ANY($1)", [ids]);
  return {
    sampleCount: Number(samples.rows[0]?.count ?? 0),
    firstObservedAt: samples.rows[0]?.first ?? null,
    lastObservedAt: samples.rows[0]?.last ?? null,
    recordedDays: Number(coverage.rows[0]?.days ?? 0),
    // Null until at least one day has been integrated — never defaulted to 100.
    averageCoveragePct: coverage.rows[0]?.coverage == null ? null : Number(coverage.rows[0].coverage),
    eventCount: Number(events.rows[0]?.count ?? 0),
    // Database size covers every device; it is a storage figure, not a per-device one.
    databaseSize: size.rows[0]?.size ?? null,
  };
});

app.get<{ Querystring: DeviceQuery & { from?:string; to?:string } }>("/api/v1/export/telemetry.csv", async (request,reply) => {
  const to=request.query.to?new Date(request.query.to):new Date();
  const from=request.query.from?new Date(request.query.from):new Date(to.getTime()-86_400_000);
  const combined = wantsCombined(request.query.device);
  const device = combined ? undefined : resolveDevice(request.query.device);
  const points = !databaseReady ? []
    : combined ? combineSeries(await Promise.all(allDeviceIds().map(id => getSamples(id, from, to, 100_000))), capacityOf, expectedIntervalSeconds)
    : device ? await getSamples(device.id, from, to, 100_000) : [];
  const filename = combined ? "flowmetrics-all-batteries.csv" : device ? `flowmetrics-${device.vendorDeviceId}.csv` : "flowmetrics-telemetry.csv";
  reply.header("Content-Type","text/csv").header("Content-Disposition",`attachment; filename=${filename}`);
  return ["observed_at,battery_soc_pct,solar_input_w,grid_input_w,battery_charge_power_w,battery_discharge_power_w,total_output_w",...points.map(p=>[p.observedAt.toISOString(),p.batterySocPct,p.solarInputW,p.gridInputW,p.batteryChargePowerW,p.batteryDischargePowerW,p.totalOutputW].join(","))].join("\n");
});

app.get<{ Querystring: DeviceQuery }>("/api/v1/live", async (request, reply) => {
  // Only pin the stream when a device is explicitly requested. Without ?device=
  // the client receives every device, which lets one connection drive a whole
  // dashboard instead of one EventSource per battery.
  const pinned = request.query.device ? resolveDevice(request.query.device) : undefined;
  const seed = pinned ? [pinned] : deviceList();

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const client = { res: raw, deviceId: pinned?.id };
  liveClients.add(client);

  // Send the most recent measurement immediately so a new tab is not blank
  // until the next poll lands.
  for (const device of seed) {
    if (device.latestSample) raw.write(`event: telemetry\ndata: ${JSON.stringify({ ...device.latestSample, deviceId: device.id })}\n\n`);
  }

  // Comment frames keep proxies from closing an idle stream between samples.
  const keepAlive = setInterval(() => { try { raw.write(": keep-alive\n\n"); } catch { /* closed */ } }, 20_000);
  raw.on("close", () => { clearInterval(keepAlive); liveClients.delete(client); });
});

const webRoot = resolve("apps/web/dist");
if (existsSync(webRoot)) { await app.register(fastifyStatic,{root:webRoot,wildcard:false}); app.setNotFoundHandler((request,reply)=> request.url.startsWith("/api/") ? reply.code(404).send({error:"Not found"}) : reply.sendFile("index.html")); }

const close = async (signal:string) => { app.log.info({ component:"api",signal },"graceful shutdown"); await connector?.stop(); for (const client of liveClients) client.res.end(); await app.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM",()=>void close("SIGTERM")); process.on("SIGINT",()=>void close("SIGINT"));
await app.listen({port:Number(process.env.FLOWMETRICS_PORT ?? 3000),host:"0.0.0.0"});
