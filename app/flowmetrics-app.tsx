"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  batteryLabel, EVENT_LABELS, eventKind, formatClock, formatDuration, formatKwh, formatPct,
  formatCount, formatRelative, formatWatts, toNum, useJson, useLiveSample, withDevice,
  type DailyRow, type DeviceSummary, type EventRow, type Numeric, type Sample, type StatsResponse, type StatusResponse,
} from "./use-flowmetrics-data";

type NavKey = "Overview" | "History" | "Events" | "Devices" | "Data" | "Settings" | "About";
type IconName = "overview" | "history" | "events" | "devices" | "data" | "settings" | "about";

const navItems: { label: NavKey; icon: IconName }[] = [
  { label: "Overview", icon: "overview" }, { label: "History", icon: "history" },
  { label: "Events", icon: "events" }, { label: "Devices", icon: "devices" },
  { label: "Data", icon: "data" }, { label: "Settings", icon: "settings" },
  { label: "About", icon: "about" },
];

const chartColors = { solar: "#f6bd44", grid: "#7d89f8", battery: "#54c995", load: "#f38f72" };

/** Shown wherever the API has returned nothing yet, instead of a placeholder figure. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="chart-note empty-note">{children}</p>;
}

/**
 * The device every page reads from. Several batteries can be bound to one
 * EcoFlow account, and they are tracked separately — totals are never summed
 * across packs, because a combined state of charge would not mean anything.
 */
const DeviceContext = createContext<string | undefined>(undefined);
const useDeviceId = () => useContext(DeviceContext);

function MiniIcon({ name }: { name: IconName | "sun" | "grid" | "battery" | "load" | "leaf" | "moon" | "bell" }) {
  const glyphs: Record<string, string> = { overview: "⌂", history: "↗", events: "≋", devices: "▣", data: "↓", settings: "⚙", about: "i", sun: "☀", grid: "⌁", battery: "▤", load: "⌂", leaf: "♧", moon: "◐", bell: "•" };
  return <span className={`icon icon-${name}`} aria-hidden="true">{glyphs[name]}</span>;
}

function StatusDot({ warn = false }: { warn?: boolean }) { return <span className={`status-dot ${warn ? "warn" : ""}`} />; }

/** Renders whatever samples the API returned; gaps stay gaps (null, not zero). */
function PowerChart({ points }: { points: Sample[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let chart: import("echarts").ECharts | undefined;
    let disposed = false;
    const resize = () => chart?.resize();
    import("echarts").then((echarts) => {
      if (!ref.current || disposed) return;
      chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
      const times = points.map(p => formatClock(p.observedAt));
      // `null` leaves a break in the line: a missing measurement is not a zero.
      const series = (pick: (p: Sample) => number | undefined) => points.map(p => { const v = pick(p); return v === undefined ? null : Math.round(v); });
      chart.setOption({
        animationDuration: 700,
        color: [chartColors.solar, chartColors.grid, chartColors.battery, chartColors.load],
        grid: { left: 54, right: 18, top: 24, bottom: 40 },
        tooltip: { trigger: "axis", backgroundColor: "#17211dcc", borderColor: "#34443e", textStyle: { color: "#fff" }, valueFormatter: (v: unknown) => v === null || v === undefined ? "no data" : `${Math.abs(Number(v)).toLocaleString()} W` },
        xAxis: { type: "category", data: times, boundaryGap: false, axisLine: { lineStyle: { color: "#dce5df" } }, axisLabel: { color: "#849089", interval: Math.max(1, Math.floor(times.length / 6)) }, axisTick: { show: false } },
        yAxis: { type: "value", axisLabel: { color: "#849089", formatter: (v: number) => v === 0 ? "0" : `${(v / 1000).toFixed(1)}kW` }, splitLine: { lineStyle: { color: "#e9efeb", type: "dashed" } } },
        dataZoom: [{ type: "inside", zoomLock: false }],
        series: [
          { name: "Solar", type: "line", data: series(p => p.solarInputW), symbol: "none", smooth: 0.3, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 }, connectNulls: false },
          { name: "Grid", type: "line", data: series(p => p.gridInputW), symbol: "none", smooth: 0.2, lineStyle: { width: 2 }, connectNulls: false },
          { name: "Battery", type: "line", data: series(p => p.batteryPowerW === undefined ? undefined : -p.batteryPowerW), symbol: "none", smooth: 0.25, lineStyle: { width: 2 }, connectNulls: false },
          { name: "Load", type: "line", data: series(p => p.totalOutputW), symbol: "none", smooth: 0.25, lineStyle: { width: 2 }, connectNulls: false },
        ],
      });
      window.addEventListener("resize", resize);
    });
    return () => { disposed = true; window.removeEventListener("resize", resize); chart?.dispose(); };
  }, [points]);
  return <div ref={ref} className="power-chart" role="img" aria-label="Solar, grid, battery and load power chart" />;
}

function SocChart({ points }: { points: Sample[] }) {
  const soc = points.filter(p => p.batterySocPct !== undefined);
  if (soc.length < 2) return <Empty>Not enough state-of-charge history recorded yet.</Empty>;
  const path = soc.map((p, i) => `${(i / (soc.length - 1)) * 100},${82 - (p.batterySocPct as number) * .65}`).join(" ");
  return <div className="soc-chart" aria-label="Battery state of charge chart">
    <div className="soc-y"><span>100%</span><span>50%</span><span>0%</span></div>
    <svg viewBox="0 0 100 84" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="socFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#54c995" stopOpacity=".32"/><stop offset="1" stopColor="#54c995" stopOpacity=".02"/></linearGradient></defs>
      <polygon points={`0,82 ${path} 100,82`} fill="url(#socFill)"/><polyline points={path} fill="none" stroke="#48b985" strokeWidth="1.3" vectorEffect="non-scaling-stroke"/>
    </svg>
    <div className="soc-x"><span>{formatClock(soc[0].observedAt)}</span><span>{formatClock(soc[Math.floor(soc.length / 2)].observedAt)}</span><span>{formatClock(soc[soc.length - 1].observedAt)}</span></div>
  </div>;
}

function Overview() {
  const deviceId = useDeviceId();
  const { sample, connected } = useLiveSample(deviceId);
  const summary = useJson<DailyRow>(withDevice("/api/v1/summary", deviceId), 60_000);
  const history = useJson<{ points: Sample[] }>(withDevice("/api/v1/history", deviceId), 120_000);
  const events = useJson<EventRow[]>(withDevice("/api/v1/events", deviceId), 60_000);

  const points = history.data?.points ?? [];
  const today = summary.data;
  const solarWh = toNum(today?.solar_energy_wh) ?? 0;
  const gridWh = toNum(today?.grid_energy_wh) ?? 0;
  const inputWh = solarWh + gridWh;
  // Input mix is solar vs grid input energy — not household self-sufficiency.
  const solarShare = inputWh > 0 ? (solarWh / inputWh) * 100 : undefined;

  const solarActive = points.filter(p => (p.solarInputW ?? 0) > 0);
  const peakSolar = toNum(today?.peak_solar_w);
  const peakGrid = toNum(today?.peak_grid_w);

  const socValues = points.map(p => p.batterySocPct).filter((v): v is number => v !== undefined);

  const metrics: [string, string, string, string][] = [
    ["Solar energy", formatKwh(today?.solar_energy_wh), "kWh", "sun"],
    ["Grid import", formatKwh(today?.grid_energy_wh), "kWh", "grid"],
    ["Output energy", formatKwh(today?.total_output_wh), "kWh", "load"],
    ["Battery charged", formatKwh(today?.battery_charge_wh), "kWh", "battery"],
  ];

  return <>
    <section className="hero-grid">
      <div className="live-card panel">
        <div className="section-heading"><div><p className="eyebrow">LIVE POWER FLOW</p><h2>Right now</h2></div><div className="live-pill"><StatusDot warn={!connected} /> {connected ? "Live" : "Reconnecting"}</div></div>
        <div className="flow-stage">
          <svg className="flow-links" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
            <g className="flow-link flow-link-active">
              <line className="flow-link-base" x1="166.67" y1="250" x2="500" y2="550" vectorEffect="non-scaling-stroke" />
              <line className="flow-link-motion" x1="166.67" y1="250" x2="500" y2="550" pathLength="100" vectorEffect="non-scaling-stroke" />
            </g>
            <g className="flow-link flow-link-active">
              <line className="flow-link-base" x1="500" y1="550" x2="833.33" y2="250" vectorEffect="non-scaling-stroke" />
              <line className="flow-link-motion flow-link-motion-delayed" x1="500" y1="550" x2="833.33" y2="250" pathLength="100" vectorEffect="non-scaling-stroke" />
            </g>
            <line className="flow-link-inactive" x1="833.33" y1="250" x2="833.33" y2="700" pathLength="100" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="flow-node solar-node"><div className="flow-anchor"><MiniIcon name="sun"/></div><div className="flow-copy"><strong>{formatWatts(sample?.solarInputW)}</strong><span>Solar</span></div></div>
          <div className="flow-node battery-node"><div className="flow-anchor battery-ring"><strong>{formatPct(sample?.batterySocPct)}</strong></div><div className="flow-copy"><span>Battery</span><small>{batteryLabel(sample)}</small></div></div>
          <div className="flow-node load-node"><div className="flow-anchor"><MiniIcon name="load"/></div><div className="flow-copy"><strong>{formatWatts(sample?.totalOutputW)}</strong><span>Home load</span></div></div>
          <div className="flow-node grid-node"><div className="flow-anchor"><MiniIcon name="grid"/></div><div className="flow-copy"><strong>{formatWatts(sample?.gridInputW)}</strong><span>Grid</span></div></div>
        </div>
        <div className="live-foot"><span><StatusDot warn={sample?.deviceOnline === false}/> {sample ? (sample.deviceOnline === false ? "Device is offline" : "Device is online") : "Waiting for the first measurement"}</span><span>{sample ? `Updated ${formatRelative(sample.observedAt)}` : "—"}</span></div>
      </div>
      <div className="impact-card panel">
        <p className="eyebrow">TODAY&apos;S INPUT MIX</p>
        <div className="mix-donut"><div><strong>{formatPct(solarShare)}</strong><span>solar</span></div></div>
        <div className="mix-legend"><span><i className="solar-key"/>Solar <b>{formatKwh(solarWh)} kWh</b></span><span><i className="grid-key"/>Grid <b>{formatKwh(gridWh)} kWh</b></span></div>
        <div className="impact-message"><MiniIcon name="leaf"/><span>
          {solarShare === undefined
            ? <><b>No input energy recorded today yet.</b><small>Solar and grid input both read zero so far.</small></>
            : solarShare >= 50
              ? <><b>Most of today&apos;s input came from the sun.</b><small>{formatKwh(Math.abs(solarWh - gridWh))} kWh more solar than grid energy</small></>
              : <><b>Most of today&apos;s input came from the grid.</b><small>{formatKwh(Math.abs(gridWh - solarWh))} kWh more grid than solar energy</small></>}
        </span></div>
      </div>
    </section>
    <section className="metric-grid">{metrics.map(([label, value, unit, icon]) => <div className="metric-card panel" key={label}><div className={`metric-icon ${icon}`}><MiniIcon name={icon as "sun"}/></div><div><span>{label}</span><strong>{value} <small>{unit}</small></strong><em>today</em></div></div>)}</section>
    <section className="panel chart-panel">
      <div className="section-heading"><div><p className="eyebrow">LAST 24 HOURS</p><h2>Power over time</h2></div><div className="chart-actions"><div className="legend"><span className="solar-key">Solar</span><span className="grid-key">Grid</span><span className="battery-key">Battery</span><span className="load-key">Load</span></div></div></div>
      {points.length > 1 ? <PowerChart points={points}/> : <Empty>{history.loading ? "Loading recorded telemetry…" : "No telemetry recorded in this window yet."}</Empty>}
      {toNum(today?.coverage_pct) !== undefined && <p className="chart-note"><StatusDot warn={(toNum(today?.coverage_pct) ?? 0) < 95}/> {formatPct(today?.coverage_pct, 1)} data coverage today{(toNum(today?.gap_seconds) ?? 0) > 0 ? ` · ${formatDuration(today?.gap_seconds)} unavailable` : ""}</p>}
    </section>
    <section className="two-col">
      <div className="panel soc-panel"><div className="section-heading"><div><p className="eyebrow">BATTERY</p><h2>State of charge</h2></div><div className="soc-summary"><span>Low <b>{formatPct(socValues.length ? Math.min(...socValues) : undefined)}</b></span><span>High <b>{formatPct(socValues.length ? Math.max(...socValues) : undefined)}</b></span></div></div><SocChart points={points}/></div>
      <div className="panel timeline-panel">
        <div className="section-heading"><div><p className="eyebrow">ENERGY TIMELINE</p><h2>Recent events</h2></div></div>
        <div className="timeline">
          {(events.data ?? []).slice(0, 8).map(event => <div className="timeline-row" key={event.id}>
            <time>{formatClock(event.started_at)}</time>
            <i className={`event-dot ${eventKind(event.event_type)}`}/>
            <span><b>{EVENT_LABELS[event.event_type] ?? event.event_type}</b><small>{event.value_start == null ? "Detected from measured telemetry" : `Measured ${Math.round(event.value_start).toLocaleString()}`}</small></span>
          </div>)}
          {!events.data?.length && <Empty>{events.loading ? "Loading events…" : "No events detected yet."}</Empty>}
        </div>
      </div>
    </section>
    <section className="two-col analytics-row">
      <div className="panel detail-card"><div className="detail-title"><div className="metric-icon sun"><MiniIcon name="sun"/></div><div><p className="eyebrow">SOLAR ANALYTICS</p><h2>Today&apos;s production</h2></div></div>
        <div className="big-stat"><strong>{formatKwh(today?.solar_energy_wh)}</strong><span>kWh collected</span></div>
        <div className="stat-list">
          <span>Peak production <b>{peakSolar == null ? "—" : `${(peakSolar / 1000).toFixed(2)} kW`}{today?.peak_solar_at ? ` · ${formatClock(today.peak_solar_at)}` : ""}</b></span>
          <span>Active duration <b>{formatDuration(today?.solar_active_seconds)}</b></span>
          <span>First / last production <b>{solarActive.length ? `${formatClock(solarActive[0].observedAt)} / ${formatClock(solarActive[solarActive.length - 1].observedAt)}` : "—"}</b></span>
        </div>
      </div>
      <div className="panel detail-card"><div className="detail-title"><div className="metric-icon grid"><MiniIcon name="grid"/></div><div><p className="eyebrow">GRID ANALYTICS</p><h2>Today&apos;s import</h2></div></div>
        <div className="big-stat grid-stat"><strong>{formatKwh(today?.grid_energy_wh)}</strong><span>kWh imported</span></div>
        <div className="stat-list">
          <span>Import duration <b>{formatDuration(today?.grid_import_seconds)}</b></span>
          <span>Peak import <b>{peakGrid == null ? "—" : formatWatts(peakGrid)}{today?.peak_grid_at ? ` · ${formatClock(today.peak_grid_at)}` : ""}</b></span>
          <span>Samples recorded <b>{formatCount(today?.sample_count)}</b></span>
        </div>
      </div>
    </section>
  </>;
}

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric" });
}

function History() {
  const deviceId = useDeviceId();
  const daily = useJson<DailyRow[]>(withDevice("/api/v1/daily", deviceId), 300_000);
  const rows = daily.data ?? [];
  const recent = rows.slice(0, 7);
  const peak = Math.max(1, ...recent.flatMap(r => [r.solar_energy_wh, r.grid_energy_wh, r.total_output_wh].map(v => toNum(v) ?? 0)));
  const total = (pick: (r: DailyRow) => Numeric) => recent.reduce((sum, r) => sum + (toNum(pick(r)) ?? 0), 0);
  const solarTotal = total(r => r.solar_energy_wh);
  const gridTotal = total(r => r.grid_energy_wh);
  const inputTotal = solarTotal + gridTotal;

  return <div className="page-stack">
    <section className="page-intro"><div><p className="eyebrow">HISTORICAL ANALYTICS</p><h1>Your energy, over time</h1><p>Every recorded day, from the measurements the collector actually stored.</p></div><a className="primary-button" href={withDevice("/api/v1/export/telemetry.csv", deviceId)}>Export CSV</a></section>
    {!rows.length ? <section className="panel"><Empty>{daily.loading ? "Loading daily records…" : "No completed days recorded yet. Daily totals appear once a day has enough samples to integrate."}</Empty></section> : <>
      <section className="history-summary">
        <div className="panel"><span>Solar collected</span><strong>{formatKwh(solarTotal)} kWh</strong><em>last {recent.length} recorded days</em></div>
        <div className="panel"><span>Grid imported</span><strong>{formatKwh(gridTotal)} kWh</strong><em>last {recent.length} recorded days</em></div>
        <div className="panel"><span>Output energy</span><strong>{formatKwh(total(r => r.total_output_wh))} kWh</strong><em>last {recent.length} recorded days</em></div>
        <div className="panel"><span>Input mix</span><strong>{inputTotal > 0 ? formatPct((solarTotal / inputTotal) * 100, 1) : "—"} solar</strong><em>solar vs grid input energy</em></div>
      </section>
      <section className="panel history-bars">
        <div className="section-heading"><div><p className="eyebrow">DAILY ENERGY</p><h2>Last {recent.length} recorded days</h2></div><div className="legend"><span className="solar-key">Solar</span><span className="grid-key">Grid</span><span className="load-key">Output</span></div></div>
        <div className="bar-chart">{[...recent].reverse().map(r => <div className="bar-group" key={r.local_date}>
          <div className="bars"><i style={{ height: `${((toNum(r.solar_energy_wh) ?? 0) / peak) * 100}%` }}/><i style={{ height: `${((toNum(r.grid_energy_wh) ?? 0) / peak) * 100}%` }}/><i style={{ height: `${((toNum(r.total_output_wh) ?? 0) / peak) * 100}%` }}/></div>
          <span>{dayLabel(r.local_date)}</span>
        </div>)}</div>
      </section>
      <section className="panel table-panel">
        <div className="section-heading"><div><p className="eyebrow">DAILY RECORDS</p><h2>Energy summary</h2></div><a className="ghost-button" href={withDevice("/api/v1/export/telemetry.csv", deviceId)}>Download CSV</a></div>
        <div className="data-table">
          <div className="table-row table-head"><span>Date</span><span>Solar</span><span>Grid</span><span>Output</span><span>Coverage</span><span/></div>
          {rows.map(r => <div className="table-row" key={r.local_date}>
            <b>{new Date(r.local_date).toLocaleDateString([], { month: "short", day: "numeric" })}</b>
            <span>{formatKwh(r.solar_energy_wh)} kWh</span>
            <span>{formatKwh(r.grid_energy_wh)} kWh</span>
            <span>{formatKwh(r.total_output_wh)} kWh</span>
            <span>{toNum(r.coverage_pct) === undefined ? "—" : <><i className="coverage-mini"><i style={{ width: `${Math.min(100, toNum(r.coverage_pct) ?? 0)}%` }}/></i>{formatPct(r.coverage_pct, 1)}</>}</span>
            <span>{formatCount(r.sample_count)} samples</span>
          </div>)}
        </div>
      </section>
    </>}
  </div>;
}

function Events() {
  const deviceId = useDeviceId();
  const events = useJson<EventRow[]>(withDevice("/api/v1/events", deviceId), 30_000);
  const [filter, setFilter] = useState<string>("all");
  const rows = events.data ?? [];
  const counts = { solar: 0, charge: 0, discharge: 0, grid: 0, quality: 0, full: 0 } as Record<string, number>;
  for (const event of rows) counts[eventKind(event.event_type)] = (counts[eventKind(event.event_type)] ?? 0) + 1;
  const shown = filter === "all" ? rows : rows.filter(e => eventKind(e.event_type) === filter);

  const filters: [string, string, number][] = [
    ["all", "All events", rows.length], ["solar", "Solar", counts.solar ?? 0],
    ["charge", "Battery charge", counts.charge ?? 0], ["discharge", "Battery discharge", counts.discharge ?? 0],
    ["grid", "Grid import", counts.grid ?? 0], ["quality", "Data quality", counts.quality ?? 0],
  ];

  return <div className="page-stack">
    <section className="page-intro"><div><p className="eyebrow">DETECTED EVENTS</p><h1>Every meaningful change</h1><p>Debounced sessions and state changes, based only on measured telemetry.</p></div></section>
    <div className="filter-row">{filters.map(([key, label, count]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label} <b>{count}</b></button>)}</div>
    <section className="panel event-log">
      {shown.map(event => <div className={`event-log-row${event.severity === "warning" ? " muted" : ""}`} key={event.id}>
        <div className={`event-badge ${eventKind(event.event_type)}`}><MiniIcon name={eventKind(event.event_type) === "solar" ? "sun" : eventKind(event.event_type) === "grid" ? "grid" : "battery"}/></div>
        <div><b>{EVENT_LABELS[event.event_type] ?? event.event_type}</b><span>{new Date(event.started_at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span></div>
        <time>{formatClock(event.started_at)}</time>
        <span className="duration">{event.value_start == null ? "—" : Math.round(event.value_start).toLocaleString()}</span>
        <span className={`severity ${event.severity}`}>{event.severity}</span>
      </div>)}
      {!shown.length && <Empty>{events.loading ? "Loading events…" : rows.length ? "No events of this type." : "No events detected yet. They appear once the collector sees a sustained change."}</Empty>}
    </section>
  </div>;
}

function Devices() {
  const status = useJson<StatusResponse>("/api/v1/status", 15_000);
  const list = useJson<DeviceSummary[]>("/api/v1/devices", 15_000);
  const collector = status.data?.collector;
  const mode = status.data?.mode;
  const connectorName = mode === "ecoflow" ? "EcoFlow IoT Open Platform" : mode === "demo" ? "Deterministic demo" : "Collection disabled";
  const devices = list.data ?? [];

  return <div className="page-stack">
    <section className="page-intro"><div><p className="eyebrow">DEVICES</p><h1>Your energy system</h1><p>Every battery this instance records, with connector health and the latest observed measurements.</p></div></section>
    <section className="device-grid">
      {devices.map(device => <DeviceCard key={device.id} device={device} connectorName={connectorName}/>)}
      {!devices.length && <div className="panel"><Empty>{list.loading ? "Loading devices…" : "No devices registered."}</Empty></div>}
      <div className="panel connector-card">
        <p className="eyebrow">CONNECTOR HEALTH</p>
        <h2>{connectorName}</h2>
        <div className="health-ring"><strong>{collector?.status ?? "unknown"}</strong><span>{collector?.error ?? "no errors reported"}</span></div>
        <div className="stat-list">
          <span>Mode <b>{mode ?? "—"}</b></span>
          <span>Devices <b>{devices.length}</b></span>
          <span>Expected interval <b>{status.data ? `${status.data.expectedIntervalSeconds} seconds` : "—"}</b></span>
          <span>Last telemetry <b>{formatRelative(collector?.lastTelemetryAt)}</b></span>
          <span>Raw payloads <b>{status.data?.rawPayloads ? "stored" : "not stored"}</b></span>
        </div>
        {mode !== "ecoflow" && <p className="chart-note">Set <code>CONNECTOR=ecoflow</code> with API keys in <code>.env</code> to record from real hardware.</p>}
      </div>
    </section>
  </div>;
}

function DeviceCard({ device, connectorName }: { device: DeviceSummary; connectorName: string }) {
  // Each card streams its own device rather than the globally selected one.
  const { sample } = useLiveSample(device.id);
  const summary = useJson<DailyRow>(withDevice("/api/v1/summary", device.id), 60_000);
  const online = sample?.deviceOnline ?? device.online ?? undefined;
  const soc = sample?.batterySocPct ?? device.batterySocPct ?? undefined;

  return <div className="panel device-card">
    <div className="device-top">
      <div className="device-illustration"><MiniIcon name="battery"/></div>
      <div>
        <span className="online-label"><StatusDot warn={online === false}/> {online === undefined ? "No data" : online ? "Online" : "Offline"}</span>
        <h2>{device.name}</h2>
        <p>{device.model} · {connectorName}</p>
      </div>
    </div>
    <div className="device-soc"><span><b>{formatPct(soc)}</b> state of charge</span><div><i style={{ width: `${soc ?? 0}%` }}/></div></div>
    <div className="device-stats">
      <span>Last telemetry<b>{formatRelative(sample?.observedAt ?? device.lastObservedAt)}</b></span>
      <span>Capacity<b>{device.capacityWh ? `${device.capacityWh.toLocaleString()} Wh` : "—"}</b></span>
      <span>Battery health<b>{formatPct(sample?.batterySohPct)}</b></span>
      <span>Battery temp<b>{sample?.batteryTemperatureC == null ? "—" : `${sample.batteryTemperatureC.toFixed(1)} °C`}</b></span>
      <span>Samples today<b>{formatCount(summary.data?.sample_count)}</b></span>
      <span>Serial<b>{device.vendorDeviceId}</b></span>
    </div>
    <div className="device-footer">
      <span>Solar {formatWatts(sample?.solarInputW)}</span>
      <span>Grid {formatWatts(sample?.gridInputW)}</span>
      <span>AC out {formatWatts(sample?.acOutputW)}</span>
      <span>DC out {formatWatts(sample?.dcOutputW)}</span>
    </div>
  </div>;
}

function DataPage() {
  const deviceId = useDeviceId();
  const stats = useJson<StatsResponse>(withDevice("/api/v1/stats", deviceId), 60_000);
  const s = stats.data;
  const exports: [string, string, string][] = [
    ["Raw telemetry", "Normalized measurements for the last 24 hours.", withDevice("/api/v1/export/telemetry.csv", deviceId)],
    ["Daily summaries", "One row per day with energy, peaks, SOC and coverage.", withDevice("/api/v1/daily", deviceId)],
    ["Detected events", "Sessions, transitions and data-quality events.", withDevice("/api/v1/events", deviceId)],
  ];
  return <div className="page-stack">
    <section className="page-intro"><div><p className="eyebrow">DATA & EXPORT</p><h1>Your data stays yours</h1><p>Storage health and exports, straight from your local database.</p></div></section>
    <section className="data-health panel">
      <div><span>First recording</span><b>{s?.firstObservedAt ? new Date(s.firstObservedAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—"}</b></div>
      <div><span>Latest recording</span><b>{formatRelative(s?.lastObservedAt)}</b></div>
      <div><span>Telemetry samples</span><b>{formatCount(s?.sampleCount)}</b></div>
      <div><span>Database size</span><b>{s?.databaseSize ?? "—"}</b></div>
      <div><span>Recorded days</span><b>{formatCount(s?.recordedDays)}</b></div>
    </section>
    <section className="export-grid">{exports.map(([title, desc, href]) => <div className="panel export-card" key={title}>
      <div className="export-icon">↓</div><h2>{title}</h2><p>{desc}</p><span>{href.includes(".csv") ? "CSV" : "JSON"}</span>
      <a className="primary-button" href={href}>Download</a>
    </div>)}</section>
    <section className="panel coverage-card">
      <div><p className="eyebrow">DATA QUALITY</p><h2>{toNum(s?.averageCoveragePct) === undefined ? "No coverage recorded yet" : (toNum(s?.averageCoveragePct) ?? 0) >= 95 ? "Coverage is healthy" : "Coverage has gaps"}</h2><p>FlowMetrics never fills in missing energy. Gaps remain visible so every total is honest.</p></div>
      <div className="coverage-score"><strong>{formatPct(s?.averageCoveragePct, 1)}</strong><span>mean daily coverage</span></div>
    </section>
  </div>;
}

function Settings() {
  const deviceId = useDeviceId();
  const status = useJson<StatusResponse>("/api/v1/status", 30_000);
  const summary = useJson<DailyRow>(withDevice("/api/v1/summary", deviceId), 60_000);
  const s = status.data;
  // Configuration is owned by .env and applied at startup, so this page reports
  // what the running service is actually using rather than offering controls
  // that could not take effect.
  const rows: [string, string][] = [
    ["Collector mode", s?.mode ?? "—"],
    ["Collector status", s?.collector.status ?? "—"],
    ["Expected interval", s ? `${s.expectedIntervalSeconds} seconds` : "—"],
    ["Timezone", summary.data?.timezone ?? "—"],
    ["Raw vendor payloads", s ? (s.rawPayloads ? "stored" : "not stored") : "—"],
    ["Database", s ? (s.databaseReady ? "reachable" : "unavailable") : "—"],
    ["Version", s?.version ?? "—"],
  ];
  return <div className="page-stack">
    <section className="page-intro"><div><p className="eyebrow">SETTINGS</p><h1>Running configuration</h1><p>What this instance is using right now. Change it in <code>.env</code>, then restart the stack.</p></div></section>
    <section className="settings-layout">
      <div className="panel settings-form">
        <h2>Current configuration</h2>
        <div className="stat-list">{rows.map(([label, value]) => <span key={label}>{label} <b>{value}</b></span>)}</div>
        {s?.collector.error && <p className="chart-note"><StatusDot warn/> {s.collector.error}</p>}
        <p className="chart-note">Edit <code>~/Documents/Docker/flowmetrics/.env</code> and run <code>docker compose up -d</code> to apply changes.</p>
      </div>
    </section>
  </div>;
}

function About() { return <div className="about-page"><div className="about-mark"><MiniIcon name="sun"/><i/></div><p className="eyebrow">FLOWMETRICS · VERSION 0.1</p><h1>Own your energy data.</h1><p className="about-lead">A self-hosted energy historian for home batteries and solar systems. No cloud lock-in. No mystery calculations. Just a permanent, honest record of the energy your home produces and uses.</p><div className="about-values"><div><b>Local first</b><span>Your telemetry lives in your own PostgreSQL database.</span></div><div><b>Vendor neutral</b><span>EcoFlow first, with a normalized core built for more.</span></div><div><b>Honest analytics</b><span>Measured, derived and missing data are always distinct.</span></div></div><a href="https://github.com/steliosk98/flowmetrics">View the open-source project →</a></div>; }

export function FlowMetricsApp() {
  const [active, setActive] = useState<NavKey>("Overview");
  const [dark, setDark] = useState(false);
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();

  const deviceList = useJson<DeviceSummary[]>("/api/v1/devices", 30_000);
  const status = useJson<StatusResponse>("/api/v1/status", 30_000);
  const devices = useMemo(() => deviceList.data ?? [], [deviceList.data]);
  const deviceId = selected ?? devices[0]?.id;
  const device = devices.find(d => d.id === deviceId);

  const { sample } = useLiveSample(deviceId);
  const events = useJson<EventRow[]>(withDevice("/api/v1/events", deviceId), 60_000);
  const mode = status.data?.mode;
  const today = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const soc = sample?.batterySocPct ?? device?.batterySocPct ?? undefined;
  const warningCount = (events.data ?? []).filter(e => e.severity === "warning").length;

  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const content = useMemo(() => ({ Overview: <Overview/>, History: <History/>, Events: <Events/>, Devices: <Devices/>, Data: <DataPage/>, Settings: <Settings/>, About: <About/> })[active], [active]);

  return <DeviceContext.Provider value={deviceId}>
    <div className="app-shell">
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span><b>FlowMetrics</b><small>Own your energy data.</small></span></div>
        <nav>{navItems.map(item => <button key={item.label} className={active===item.label?"active":""} onClick={() => { setActive(item.label); setMenu(false); }}><MiniIcon name={item.icon}/><span>{item.label}</span>{item.label==="Events"&&warningCount>0&&<em>{warningCount}</em>}</button>)}</nav>
        <div className="sidebar-bottom">
          {/* A switcher only earns its place when there is more than one battery. */}
          {devices.length > 1 && <div className="device-switcher">
            <label htmlFor="device-select">Viewing</label>
            <select id="device-select" value={deviceId ?? ""} onChange={event => setSelected(event.target.value)}>
              {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>}
          <div className="device-mini">
            <div className="mini-battery"><i style={{ height: `${soc ?? 0}%` }}/></div>
            <span><b>{device?.name ?? (mode === "ecoflow" ? "EcoFlow battery" : "Delta 2 Max")}</b><small><StatusDot warn={sample?.deviceOnline === false}/> {sample ? `${sample.deviceOnline === false ? "Offline" : "Online"} · ${formatPct(soc)}` : "Waiting for data"}</small></span>
          </div>
          {mode !== "ecoflow" && <div className="demo-badge"><span>{mode === "off" ? "COLLECTION OFF" : "DEMO MODE"}</span><small>{mode === "off" ? "Serving recorded history only" : "Deterministic sample data — not your battery"}</small></div>}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={()=>setMenu(!menu)} aria-label="Toggle navigation">☰</button>
          <div><p>{active === "Overview" ? today : active}</p><span>{active === "Overview" ? (devices.length > 1 && device ? `${device.name} — a clear view of your home energy.` : "A clear view of your home energy.") : "FlowMetrics energy historian"}</span></div>
          <div className="top-actions">
            <button className="round-button" onClick={()=>setDark(!dark)} aria-label="Toggle color theme"><MiniIcon name="moon"/></button>
            <div className="avatar">SK</div>
          </div>
        </header>
        <main>{content}</main>
      </div>
    </div>
  </DeviceContext.Provider>;
}
