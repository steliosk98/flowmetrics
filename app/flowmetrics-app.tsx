"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type NavKey = "Overview" | "History" | "Events" | "Devices" | "Data" | "Settings" | "About";
type IconName = "overview" | "history" | "events" | "devices" | "data" | "settings" | "about";

const navItems: { label: NavKey; icon: IconName }[] = [
  { label: "Overview", icon: "overview" }, { label: "History", icon: "history" },
  { label: "Events", icon: "events" }, { label: "Devices", icon: "devices" },
  { label: "Data", icon: "data" }, { label: "Settings", icon: "settings" },
  { label: "About", icon: "about" },
];

const chartColors = { solar: "#f6bd44", grid: "#7d89f8", battery: "#54c995", load: "#f38f72" };
const powerTimes = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const solar = powerTimes.map((_, i) => {
  const h = i / 4;
  if (h < 6.3 || h > 19.2) return 0;
  const base = Math.sin(((h - 6.3) / 12.9) * Math.PI) * 1350;
  const cloud = h > 12.4 && h < 13.6 ? 0.63 : h > 15.1 && h < 15.8 ? 0.78 : 1;
  return Math.max(0, Math.round(base * cloud + Math.sin(i * 1.7) * 45));
});
const load = powerTimes.map((_, i) => {
  const h = i / 4;
  const evening = h > 17.5 && h < 22.2 ? 310 : 0;
  const meal = (h > 7.2 && h < 8.4) || (h > 12.1 && h < 13) ? 230 : 0;
  return Math.round(210 + evening + meal + Math.sin(i * 0.7) * 40);
});
const grid = powerTimes.map((_, i) => {
  const h = i / 4;
  return h < 5.8 ? Math.round(320 + Math.sin(i) * 25) : h > 22.1 ? 460 : (h > 12.7 && h < 13.2 ? 110 : 0);
});
const battery = powerTimes.map((_, i) => {
  const h = i / 4;
  if (h > 7 && h < 14.2) return -Math.max(0, Math.round(solar[i] - load[i]));
  if ((h >= 14.2 && h < 18) || (h > 18 && h < 22.1)) return Math.min(620, load[i]);
  return h < 5.8 ? 0 : Math.min(260, load[i]);
});
const soc = powerTimes.map((_, i) => {
  const h = i / 4;
  if (h < 6) return 31 + h * 0.4;
  if (h < 10.2) return 33 + (h - 6) * 8;
  if (h < 14.2) return Math.min(100, 67 + (h - 10.2) * 10);
  if (h < 18) return 100 - (h - 14.2) * 1.3;
  if (h < 22.1) return 95 - (h - 18) * 12.3;
  return 44;
});

function MiniIcon({ name }: { name: IconName | "sun" | "grid" | "battery" | "load" | "leaf" | "moon" | "bell" }) {
  const glyphs: Record<string, string> = { overview: "⌂", history: "↗", events: "≋", devices: "▣", data: "↓", settings: "⚙", about: "i", sun: "☀", grid: "⌁", battery: "▤", load: "⌂", leaf: "♧", moon: "◐", bell: "•" };
  return <span className={`icon icon-${name}`} aria-hidden="true">{glyphs[name]}</span>;
}

function StatusDot({ warn = false }: { warn?: boolean }) { return <span className={`status-dot ${warn ? "warn" : ""}`} />; }

function PowerChart() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let chart: import("echarts").ECharts | undefined;
    let disposed = false;
    import("echarts").then((echarts) => {
      if (!ref.current || disposed) return;
      chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
      chart.setOption({
        animationDuration: 700,
        color: [chartColors.solar, chartColors.grid, chartColors.battery, chartColors.load],
        grid: { left: 54, right: 18, top: 24, bottom: 40 },
        tooltip: { trigger: "axis", backgroundColor: "#17211dcc", borderColor: "#34443e", textStyle: { color: "#fff" }, valueFormatter: (v: unknown) => `${Math.abs(Number(v)).toLocaleString()} W` },
        xAxis: { type: "category", data: powerTimes, boundaryGap: false, axisLine: { lineStyle: { color: "#dce5df" } }, axisLabel: { color: "#849089", interval: 15 }, axisTick: { show: false } },
        yAxis: { type: "value", min: -1000, max: 1600, interval: 500, axisLabel: { color: "#849089", formatter: (v: number) => v === 0 ? "0" : `${v / 1000}kW` }, splitLine: { lineStyle: { color: "#e9efeb", type: "dashed" } } },
        dataZoom: [{ type: "inside", zoomLock: false }],
        series: [
          { name: "Solar", type: "line", data: solar, symbol: "none", smooth: 0.3, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 } },
          { name: "Grid", type: "line", data: grid, symbol: "none", smooth: 0.2, lineStyle: { width: 2 } },
          { name: "Battery", type: "line", data: battery.map(v => -v), symbol: "none", smooth: 0.25, lineStyle: { width: 2 } },
          { name: "Load", type: "line", data: load, symbol: "none", smooth: 0.25, lineStyle: { width: 2 } },
        ],
      });
      const resize = () => chart?.resize();
      window.addEventListener("resize", resize);
      chart.on("finished", () => undefined);
    });
    return () => { disposed = true; chart?.dispose(); };
  }, []);
  return <div ref={ref} className="power-chart" role="img" aria-label="Daily solar, grid, battery and load power chart" />;
}

function SocChart() {
  const points = soc.map((v, i) => `${(i / (soc.length - 1)) * 100},${82 - v * .65}`).join(" ");
  return <div className="soc-chart" aria-label="Battery state of charge chart">
    <div className="soc-y"><span>100%</span><span>50%</span><span>0%</span></div>
    <svg viewBox="0 0 100 84" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="socFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#54c995" stopOpacity=".32"/><stop offset="1" stopColor="#54c995" stopOpacity=".02"/></linearGradient></defs>
      <polygon points={`0,82 ${points} 100,82`} fill="url(#socFill)"/><polyline points={points} fill="none" stroke="#48b985" strokeWidth="1.3" vectorEffect="non-scaling-stroke"/>
      <line x1="42" x2="42" y1="4" y2="82" stroke="#d9e5de" strokeDasharray="2 2"/><circle cx="42" cy="17" r="1.6" fill="#48b985"/>
    </svg>
    <div className="soc-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
  </div>;
}

const metrics = [
  ["Solar energy", "8.42", "kWh", "+18%", "sun"], ["Grid import", "2.18", "kWh", "−32%", "grid"],
  ["Output energy", "6.73", "kWh", "+6%", "load"], ["Battery charged", "5.21", "kWh", "+12%", "battery"],
] as const;
const timeline = [
  ["06:38", "Solar production started", "Solar climbed above 35 W", "solar"],
  ["07:12", "Battery charging started", "Charging from measured input", "charge"],
  ["10:14", "Battery reached full", "State of charge reached 100%", "full"],
  ["17:46", "Battery discharge started", "Powering the evening load", "discharge"],
  ["19:18", "Solar production stopped", "Solar stayed below 20 W", "solar"],
  ["22:14", "Grid import started", "Import rose to 462 W", "grid"],
] as const;

function Overview() {
  return <>
    <section className="hero-grid">
      <div className="live-card panel">
        <div className="section-heading"><div><p className="eyebrow">LIVE POWER FLOW</p><h2>Right now</h2></div><div className="live-pill"><StatusDot /> Live</div></div>
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
            <line className="flow-link-inactive" x1="833.33" y1="250" x2="833.33" y2="780" pathLength="100" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="flow-node solar-node"><div className="flow-anchor"><MiniIcon name="sun"/></div><div className="flow-copy"><strong>843 W</strong><span>Solar</span></div></div>
          <div className="flow-node battery-node"><div className="flow-anchor battery-ring"><strong>73%</strong></div><div className="flow-copy"><span>Battery</span><small>326 W charging</small></div></div>
          <div className="flow-node load-node"><div className="flow-anchor"><MiniIcon name="load"/></div><div className="flow-copy"><strong>491 W</strong><span>Home load</span></div></div>
          <div className="flow-node grid-node"><div className="flow-anchor"><MiniIcon name="grid"/></div><div className="flow-copy"><strong>0 W</strong><span>Grid</span></div></div>
        </div>
        <div className="live-foot"><span><StatusDot/> Delta 2 Max is online</span><span>Updated 8 sec ago</span></div>
      </div>
      <div className="impact-card panel">
        <p className="eyebrow">TODAY&apos;S INPUT MIX</p><div className="mix-donut"><div><strong>79%</strong><span>solar</span></div></div>
        <div className="mix-legend"><span><i className="solar-key"/>Solar <b>8.42 kWh</b></span><span><i className="grid-key"/>Grid <b>2.18 kWh</b></span></div>
        <div className="impact-message"><MiniIcon name="leaf"/><span><b>Most of today&apos;s input came from the sun.</b><small>6.24 kWh more solar than grid energy</small></span></div>
      </div>
    </section>
    <section className="metric-grid">{metrics.map(([label, value, unit, change, icon]) => <div className="metric-card panel" key={label}><div className={`metric-icon ${icon}`}><MiniIcon name={icon}/></div><div><span>{label}</span><strong>{value} <small>{unit}</small></strong><em className={change.startsWith("−") ? "good" : "up"}>{change} vs yesterday</em></div></div>)}</section>
    <section className="panel chart-panel"><div className="section-heading"><div><p className="eyebrow">TODAY · 00:00–NOW</p><h2>Power throughout the day</h2></div><div className="chart-actions"><div className="legend"><span className="solar-key">Solar</span><span className="grid-key">Grid</span><span className="battery-key">Battery</span><span className="load-key">Load</span></div><button className="ghost-button">Expand ↗</button></div></div><PowerChart/><p className="chart-note"><StatusDot/> 98.7% data coverage · 19 minutes unavailable</p></section>
    <section className="two-col">
      <div className="panel soc-panel"><div className="section-heading"><div><p className="eyebrow">BATTERY</p><h2>State of charge</h2></div><div className="soc-summary"><span>Low <b>31%</b></span><span>High <b>100%</b></span></div></div><SocChart/></div>
      <div className="panel timeline-panel"><div className="section-heading"><div><p className="eyebrow">ENERGY TIMELINE</p><h2>Today&apos;s story</h2></div><button className="text-button">View all events →</button></div><div className="timeline">{timeline.map(([time, title, sub, type]) => <div className="timeline-row" key={time}><time>{time}</time><i className={`event-dot ${type}`}/><span><b>{title}</b><small>{sub}</small></span></div>)}</div></div>
    </section>
    <section className="two-col analytics-row">
      <div className="panel detail-card"><div className="detail-title"><div className="metric-icon sun"><MiniIcon name="sun"/></div><div><p className="eyebrow">SOLAR ANALYTICS</p><h2>A bright production day</h2></div></div><div className="big-stat"><strong>8.42</strong><span>kWh collected</span><em>+18% vs yesterday</em></div><div className="stat-list"><span>Peak production <b>1.36 kW · 12:08</b></span><span>Active duration <b>12h 40m</b></span><span>Average while active <b>665 W</b></span><span>First / last production <b>06:38 / 19:18</b></span></div></div>
      <div className="panel detail-card"><div className="detail-title"><div className="metric-icon grid"><MiniIcon name="grid"/></div><div><p className="eyebrow">GRID ANALYTICS</p><h2>Less grid, later in the day</h2></div></div><div className="big-stat grid-stat"><strong>2.18</strong><span>kWh imported</span><em>−32% vs yesterday</em></div><div className="session-bar"><i/><i/><i/></div><div className="stat-list"><span>Import sessions <b>3</b></span><span>Total duration <b>4h 31m</b></span><span>Longest session <b>2h 46m</b></span><span>Peak import <b>622 W · 02:17</b></span></div></div>
    </section>
  </>;
}

const dailyHistory = [
  ["Fri 7", 8.42, 2.18, 6.73, 98.7], ["Thu 6", 7.12, 3.21, 6.34, 100], ["Wed 5", 6.48, 4.06, 6.91, 96.2],
  ["Tue 4", 9.14, 1.82, 7.06, 99.8], ["Mon 3", 8.76, 2.44, 6.58, 100], ["Sun 2", 7.65, 2.87, 6.11, 100], ["Sat 1", 8.91, 2.03, 6.47, 94.8],
];

function History() { return <div className="page-stack"><section className="page-intro"><div><p className="eyebrow">HISTORICAL ANALYTICS</p><h1>Your energy, over time</h1><p>Compare production, import and consumption across every recorded day.</p></div><button className="primary-button">Export period</button></section><div className="range-tabs">{["7D","30D","This month","Previous month","This year","All","Custom"].map((x,i)=><button className={i===0?"active":""} key={x}>{x}</button>)}</div><section className="history-summary"><div className="panel"><span>Solar collected</span><strong>56.48 kWh</strong><em>+9.4% vs previous 7 days</em></div><div className="panel"><span>Grid imported</span><strong>18.61 kWh</strong><em>−14.2% vs previous 7 days</em></div><div className="panel"><span>Output energy</span><strong>46.20 kWh</strong><em>+3.8% vs previous 7 days</em></div><div className="panel"><span>Input mix</span><strong>75.2% solar</strong><em>Best day: Tuesday · 83.4%</em></div></section><section className="panel history-bars"><div className="section-heading"><div><p className="eyebrow">DAILY ENERGY</p><h2>Last seven days</h2></div><div className="legend"><span className="solar-key">Solar</span><span className="grid-key">Grid</span><span className="load-key">Output</span></div></div><div className="bar-chart">{dailyHistory.map(d=><div className="bar-group" key={d[0]}><div className="bars"><i style={{height:`${Number(d[1])*8}%`}}/><i style={{height:`${Number(d[2])*8}%`}}/><i style={{height:`${Number(d[3])*8}%`}}/></div><span>{d[0]}</span></div>)}</div></section><section className="panel table-panel"><div className="section-heading"><div><p className="eyebrow">DAILY RECORDS</p><h2>Energy summary</h2></div><button className="ghost-button">Download CSV</button></div><div className="data-table"><div className="table-row table-head"><span>Date</span><span>Solar</span><span>Grid</span><span>Output</span><span>Coverage</span><span></span></div>{dailyHistory.map(d=><div className="table-row" key={d[0]}><b>Aug {d[0]}</b><span>{Number(d[1]).toFixed(2)} kWh</span><span>{Number(d[2]).toFixed(2)} kWh</span><span>{Number(d[3]).toFixed(2)} kWh</span><span><i className="coverage-mini"><i style={{width:`${d[4]}%`}}/></i>{d[4]}%</span><button>View day →</button></div>)}</div></section></div>; }

function Events() { return <div className="page-stack"><section className="page-intro"><div><p className="eyebrow">DETECTED EVENTS</p><h1>Every meaningful change</h1><p>Debounced sessions and state changes, based only on measured telemetry.</p></div></section><div className="filter-row"><button className="active">All events <b>24</b></button><button>Solar <b>4</b></button><button>Battery <b>12</b></button><button>Grid import <b>6</b></button><button>Data quality <b>2</b></button></div><section className="panel event-log"><div className="event-date"><span>Today · August 7</span><i/></div>{timeline.map(([time,title,sub,type],i)=><div className="event-log-row" key={time}><div className={`event-badge ${type}`}><MiniIcon name={type==="solar"?"sun":type==="grid"?"grid":"battery"}/></div><div><b>{title}</b><span>{sub}</span></div><time>{time}</time><span className="duration">{i%2?"Active 3h 02m":"Completed"}</span><button>Details</button></div>)}<div className="event-date"><span>Yesterday · August 6</span><i/></div>{timeline.slice(0,3).map(([time,title,sub,type])=><div className="event-log-row muted" key={time}><div className={`event-badge ${type}`}><MiniIcon name={type==="solar"?"sun":"battery"}/></div><div><b>{title}</b><span>{sub}</span></div><time>{time}</time><span className="duration">Completed</span><button>Details</button></div>)}</section></div>; }

function Devices() { return <div className="page-stack"><section className="page-intro"><div><p className="eyebrow">DEVICES</p><h1>Your energy system</h1><p>Connector health, capabilities and the latest observed measurements.</p></div><button className="primary-button">Add device</button></section><section className="device-grid"><div className="panel device-card"><div className="device-top"><div className="device-illustration"><MiniIcon name="battery"/></div><div><span className="online-label"><StatusDot/> Online</span><h2>Delta 2 Max</h2><p>EcoFlow · Demo connector</p></div><button>•••</button></div><div className="device-soc"><span><b>73%</b> state of charge</span><div><i style={{width:"73%"}}/></div></div><div className="device-stats"><span>Last telemetry<b>8 seconds ago</b></span><span>Capacity<b>2,048 Wh</b></span><span>Timezone<b>Europe/Chisinau</b></span><span>First recording<b>January 12, 2026</b></span></div><div className="device-footer"><span>Solar</span><span>Grid input</span><span>AC output</span><span>Battery SOC</span></div></div><div className="panel connector-card"><p className="eyebrow">CONNECTOR HEALTH</p><h2>Deterministic demo</h2><div className="health-ring"><strong>Healthy</strong><span>99.98% uptime</span></div><div className="stat-list"><span>Expected interval <b>10 seconds</b></span><span>Last connected <b>Just now</b></span><span>Samples today <b>8,142</b></span><span>Reconnects this month <b>2</b></span></div><button className="ghost-button">Connector settings</button></div></section></div>; }

function DataPage() { return <div className="page-stack"><section className="page-intro"><div><p className="eyebrow">DATA & EXPORT</p><h1>Your data stays yours</h1><p>Inspect storage health and export any part of your permanent local history.</p></div></section><section className="data-health panel"><div><span>First recording</span><b>Jan 12, 2026</b></div><div><span>Latest recording</span><b>8 sec ago</b></div><div><span>Telemetry samples</span><b>1,794,248</b></div><div><span>Database size</span><b>842 MB</b></div><div><span>Overall coverage</span><b>99.2%</b></div></section><section className="export-grid">{[["Daily summaries","One row per day with energy, peaks, SOC and coverage.","CSV"],["Hourly summaries","Accurate energy and time metrics by local hour.","CSV"],["Raw telemetry","Normalized measurements for a selected date range.","CSV · JSON"],["Detected events","Sessions, transitions and data-quality events.","CSV · JSON"]].map(x=><div className="panel export-card" key={x[0]}><div className="export-icon">↓</div><h2>{x[0]}</h2><p>{x[1]}</p><span>{x[2]}</span><button className="primary-button">Choose range</button></div>)}</section><section className="panel coverage-card"><div><p className="eyebrow">DATA QUALITY</p><h2>Coverage is healthy</h2><p>FlowMetrics never fills in missing energy. Gaps remain visible so every total is honest.</p></div><div className="coverage-score"><strong>99.2%</strong><span>all-time coverage</span></div></section></div>; }

function Settings() { return <div className="page-stack"><section className="page-intro"><div><p className="eyebrow">SETTINGS</p><h1>Shape your historian</h1><p>Local preferences, collection behavior and transparent calculation rules.</p></div></section><section className="settings-layout"><div className="settings-nav panel"><button className="active">General</button><button>Collection</button><button>Events</button><button>Data retention</button><button>Security</button><button>Appearance</button></div><div className="panel settings-form"><h2>General</h2><label>Instance name<input defaultValue="Home energy"/></label><label>Default timezone<select defaultValue="Europe/Chisinau"><option>Europe/Chisinau</option><option>Europe/London</option><option>America/New_York</option></select></label><label>Default device<select><option>Delta 2 Max</option></select></label><div className="setting-toggle"><span><b>Store raw vendor payloads</b><small>Disabled by default to reduce storage and protect privacy.</small></span><button aria-label="Toggle raw payload storage"><i/></button></div><div className="setting-toggle"><span><b>Incomplete data warnings</b><small>Always show coverage when any telemetry is missing.</small></span><button className="on" aria-label="Toggle incomplete data warnings"><i/></button></div><button className="primary-button">Save changes</button></div></section></div>; }

function About() { return <div className="about-page"><div className="about-mark"><MiniIcon name="sun"/><i/></div><p className="eyebrow">FLOWMETRICS · VERSION 0.1</p><h1>Own your energy data.</h1><p className="about-lead">A self-hosted energy historian for home batteries and solar systems. No cloud lock-in. No mystery calculations. Just a permanent, honest record of the energy your home produces and uses.</p><div className="about-values"><div><b>Local first</b><span>Your telemetry lives in your own PostgreSQL database.</span></div><div><b>Vendor neutral</b><span>EcoFlow first, with a normalized core built for more.</span></div><div><b>Honest analytics</b><span>Measured, derived and missing data are always distinct.</span></div></div><a href="https://github.com/steliosk98/flowmetrics">View the open-source project →</a></div>; }

export function FlowMetricsApp() {
  const [active, setActive] = useState<NavKey>("Overview");
  const [dark, setDark] = useState(false);
  const [menu, setMenu] = useState(false);
  const currentDate = "Friday, August 7";
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const content = useMemo(() => ({ Overview: <Overview/>, History: <History/>, Events: <Events/>, Devices: <Devices/>, Data: <DataPage/>, Settings: <Settings/>, About: <About/> })[active], [active]);
  return <div className="app-shell">
    <aside className={menu ? "sidebar open" : "sidebar"}>
      <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span><b>FlowMetrics</b><small>Own your energy data.</small></span></div>
      <nav>{navItems.map(item => <button key={item.label} className={active===item.label?"active":""} onClick={() => { setActive(item.label); setMenu(false); }}><MiniIcon name={item.icon}/><span>{item.label}</span>{item.label==="Events"&&<em>3</em>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="device-mini"><div className="mini-battery"><i style={{height:"73%"}}/></div><span><b>Delta 2 Max</b><small><StatusDot/> Online · 73%</small></span><button aria-label="Device options">⌄</button></div><div className="demo-badge"><span>DEMO MODE</span><small>Deterministic sample data</small></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><button className="mobile-menu" onClick={()=>setMenu(!menu)} aria-label="Toggle navigation">☰</button><div><p>{active === "Overview" ? currentDate : active}</p><span>{active === "Overview" ? "A clear view of your home energy." : "FlowMetrics energy historian"}</span></div><div className="top-actions"><button className="date-button"><span>‹</span><b>Today</b><span>›</span></button><button className="round-button" onClick={()=>setDark(!dark)} aria-label="Toggle color theme"><MiniIcon name="moon"/></button><button className="round-button bell" aria-label="Notifications"><MiniIcon name="bell"/><i/></button><div className="avatar">SK</div></div></header>
      <main>{content}</main>
    </div>
  </div>;
}
