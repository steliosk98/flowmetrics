import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DemoConnector, demoSampleAt, EventDetector } from "../packages/core/index";
import { ensureDemoDevice, persistTelemetry, pool, runMigrations } from "./db";
import { getSamples, rebuildDay } from "./analytics";
import { registerAuth } from "./auth";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.secret", "*.accessKey"] } });
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });

let databaseReady = false; let deviceId = "demo-delta-2-max"; const detector = new EventDetector(); const connector = new DemoConnector();
try { await runMigrations(); deviceId = await ensureDemoDevice(); databaseReady = true; } catch (error) { app.log.warn({ component: "db", error }, "database unavailable; health remains degraded"); }
if (databaseReady) await registerAuth(app);

if (process.env.DEMO_MODE !== "false") await connector.start(async sample => {
  sample.deviceId = deviceId;
  if (!databaseReady) return;
  await persistTelemetry(deviceId, sample);
  for (const event of detector.process(sample)) await pool.query(`INSERT INTO device_events (device_id,event_type,started_at,severity,value_start) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [deviceId,event.type,event.at,event.severity,event.value]);
});

app.get("/api/v1/health", async (_request, reply) => reply.code(databaseReady ? 200 : 503).send({ healthy: databaseReady, database: databaseReady ? "reachable" : "unavailable", migrations: databaseReady ? "current" : "unknown", collector: connector.getHealth(), timestamp: new Date().toISOString() }));
app.get("/api/v1/status", async () => ({ version: "0.1.0", mode: process.env.DEMO_MODE !== "false" ? "demo" : "connector", databaseReady, rawPayloads: process.env.STORE_RAW_PAYLOADS === "true" }));
app.get("/api/v1/current", async () => {
  if (!databaseReady) return demoSampleAt(new Date());
  const result = await pool.query("SELECT * FROM telemetry_samples WHERE device_id=$1 ORDER BY observed_at DESC LIMIT 1", [deviceId]);
  return result.rows[0] ?? demoSampleAt(new Date());
});
app.get<{ Querystring: { from?: string; to?: string; maxPoints?: string } }>("/api/v1/history", async request => {
  const to = request.query.to ? new Date(request.query.to) : new Date(); const from = request.query.from ? new Date(request.query.from) : new Date(to.getTime()-86_400_000);
  if (!databaseReady) return { from, to, coveragePct: 100, points: Array.from({ length: 288 },(_,i)=>demoSampleAt(new Date(from.getTime()+i*300_000))) };
  const points = await getSamples(deviceId,from,to,Math.min(5000,Math.max(100,Number(request.query.maxPoints ?? 3000)))); return { from,to,points };
});
app.get("/api/v1/summary", async () => { if (!databaseReady) return { coveragePct:100,mode:"demo" }; await rebuildDay(deviceId,new Date()); const result=await pool.query("SELECT * FROM energy_daily WHERE device_id=$1 ORDER BY local_date DESC LIMIT 1",[deviceId]); return result.rows[0] ?? {}; });
app.get("/api/v1/daily", async () => databaseReady ? (await pool.query("SELECT * FROM energy_daily WHERE device_id=$1 ORDER BY local_date DESC LIMIT 366",[deviceId])).rows : []);
app.get("/api/v1/events", async () => databaseReady ? (await pool.query("SELECT * FROM device_events WHERE device_id=$1 ORDER BY started_at DESC LIMIT 500",[deviceId])).rows : []);
app.get<{ Querystring:{ from?:string; to?:string } }>("/api/v1/export/telemetry.csv", async (request,reply) => { const to=request.query.to?new Date(request.query.to):new Date();const from=request.query.from?new Date(request.query.from):new Date(to.getTime()-86_400_000);const points=databaseReady?await getSamples(deviceId,from,to,100_000):[];reply.header("Content-Type","text/csv").header("Content-Disposition","attachment; filename=flowmetrics-telemetry.csv");return ["observed_at,battery_soc_pct,solar_input_w,grid_input_w,battery_charge_power_w,battery_discharge_power_w,total_output_w",...points.map(p=>[p.observedAt.toISOString(),p.batterySocPct,p.solarInputW,p.gridInputW,p.batteryChargePowerW,p.batteryDischargePowerW,p.totalOutputW].join(","))].join("\n"); });
app.get("/api/v1/live", async (_request,reply) => { reply.hijack(); reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});const send=()=>reply.raw.write(`event: telemetry\ndata: ${JSON.stringify(demoSampleAt(new Date()))}\n\n`);send();const timer=setInterval(send,10_000);reply.raw.on("close",()=>clearInterval(timer)); });

const webRoot = resolve("apps/web/dist");
if (existsSync(webRoot)) { await app.register(fastifyStatic,{root:webRoot,wildcard:false}); app.setNotFoundHandler((request,reply)=> request.url.startsWith("/api/") ? reply.code(404).send({error:"Not found"}) : reply.sendFile("index.html")); }

const close = async (signal:string) => { app.log.info({ component:"api",signal },"graceful shutdown"); await connector.stop(); await app.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM",()=>void close("SIGTERM")); process.on("SIGINT",()=>void close("SIGINT"));
await app.listen({port:Number(process.env.FLOWMETRICS_PORT ?? 3000),host:"0.0.0.0"});
