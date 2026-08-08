# EcoFlow connector

Live EcoFlow telemetry is implemented and enabled. It talks to the **EcoFlow IoT
Open Platform** over signed HTTP, using only endpoints, headers and fields taken
from the official developer documentation at <https://developer-eu.ecoflow.com>.

Supported today: **DELTA 2 and DELTA 2 Max**. Other models authenticate and list
fine, but report different quota keys and need their own mapping module.

## Getting API credentials

The developer platform key pair is separate from your EcoFlow app login. You have
to create it yourself — it requires signing in to your own account.

1. Bind the battery in the EcoFlow mobile app, if it is not already.
2. Go to <https://developer-eu.ecoflow.com> and sign in with **the same account**.
   Shared devices do not appear over the API — only devices bound to the account.
3. Open the IoT Developer Platform and request access. Approval is not instant;
   EcoFlow reviews the request and emails you.
4. Once approved, copy the **AccessKey** and **SecretKey**.

Put them in `.env` — never in the compose file or anywhere tracked by git:

```bash
CONNECTOR=ecoflow
ECOFLOW_ACCESS_KEY=...
ECOFLOW_SECRET_KEY=...
```

### More than one battery

Leave `ECOFLOW_SERIAL_NUMBER` empty and every device bound to the account is
recorded. Each gets its own device row, its own history, its own event detector
and its own tile in the dashboard's device switcher.

Per-battery tracking is the default and nothing is silently merged. A combined
site view is available as an explicit choice — see below for exactly which
quantities can be combined honestly and which are left out.

Set a comma-separated list to record only some of them:

```bash
ECOFLOW_SERIAL_NUMBER=R331XXXXXXXXXXXX,R331YYYYYYYYYYYY
```

One unreachable device does not stop the others being recorded; the connector
reports `degraded` and names which device failed.

### Combined view

With more than one battery the dashboard offers an **All batteries** view, also
available on the API as `?device=all`. What is and is not combined:

| Quantity | Combined how |
|---|---|
| Power, energy | Summed — these are additive |
| State of charge | Weighted by usable capacity, never averaged. Two packs at 50% and 100% of different sizes are not "75% full" |
| Temperature | Hottest pack, so one hot battery is not averaged away |
| Grid voltage / frequency | Property of the shared supply, not summed |
| Online | Only online when every battery is |
| Peaks, SOC extremes | **Omitted.** Two batteries peaking at different moments never produced the sum of their peaks, and the true combined peak cannot be recovered from pre-aggregated daily rows |
| Coverage | The worst-covered battery |

A time bucket appears in the combined history only when **every** battery
reported in it. Summing a subset would understate site power and corrupt energy
totals, so a gap in one battery becomes a gap for the site.

## Verifying before you start the stack

```bash
node scripts/ecoflow-probe.mjs
```

The probe signs a real request, lists the devices bound to the account, and prints
which of the fields FlowMetrics maps your hardware actually reports. It writes
nothing and prints no credential. Add `--raw` to dump every quota key the device
returns, which is what you want when adding support for another model.

## What is used

| Purpose | Endpoint |
|---|---|
| Bound device list, online state | `GET /iot-open/sign/device/list` |
| All current telemetry | `GET /iot-open/sign/device/quota/all` |
| MQTT credentials (implemented, unused) | `GET /iot-open/sign/certification` |

Requests are signed per the documented algorithm: flatten nested parameters,
sort the pairs by ASCII value, append `accessKey`/`nonce`/`timestamp`, HMAC-SHA256
with the secret key, hex-encode. EcoFlow publishes a worked example with an
expected signature; that vector is asserted in `packages/connectors/ecoflow-signing.test.ts`,
so a regression in the algorithm fails the test suite rather than failing against
live hardware.

Transport is **polling**, not MQTT, defaulting to one request every 30 seconds.
The historian integrates power over time rather than reacting to individual
pushes, so polling is sufficient, and it avoids an MQTT dependency. EcoFlow does
not publish a rate limit, hence the conservative default; `ECOFLOW_POLL_INTERVAL_MS`
changes it.

## Field mapping (DELTA 2 / DELTA 2 Max)

Every key below comes from the official `GetAllQuotaResponse` table for Delta 2 Max.
Where a field is absent from a payload, FlowMetrics stores `NULL` — never `0`.

Verified against live DELTA 2 hardware (firmware as of August 2026, 238 quota keys):
the plain DELTA 2 does **not** report `pd.pv1ChargeWatts`, `pd.pv2ChargeWatts` or
either `pd.pv*ChargeType`. It reports `mppt.inWatts` and `mppt.chgType` instead, so
the documented fallbacks below are the ones that actually carry solar on that model.
The DELTA 2 has a single PV input, so `solarInput2W` stays `NULL` rather than 0.

| FlowMetrics | EcoFlow quota key | Notes |
|---|---|---|
| `batterySocPct` | `bms_emsStatus.f32LcdShowSoc` → `bms_bmsStatus.f32ShowSoc` → `pd.soc` | Decimal fields preferred; integer fallback sets a quality flag |
| `batteryChargePowerW` | `bms_bmsStatus.inputWatts` | Battery-side, not site-side |
| `batteryDischargePowerW` | `bms_bmsStatus.outputWatts` | |
| `solarInputW` | `pd.pv1ChargeWatts` → `mppt.inWatts`, plus `pd.pv2ChargeWatts` | Counted only when the charge type says solar — see below |
| `gridInputW` | `inv.inputWatts` | AC-side charging power |
| `gridVoltageV` | `inv.acInVol` / 1000 | Reported in millivolts |
| `gridFrequencyHz` | `inv.acInFreq` | |
| `acOutputW` | `inv.outputWatts` → `pd.invOutWatts` | |
| `dcOutputW` | sum of `pd.carWatts`, `pd.usb1Watts`, `pd.usb2Watts`, `pd.qcUsb1Watts`, `pd.qcUsb2Watts`, `pd.typec1Watts`, `pd.typec2Watts`, `pd.wireWatts` | |
| `totalOutputW` | `pd.wattsOutSum` | |
| `batteryTemperatureC` | `bms_bmsStatus.temp` | |
| `inverterTemperatureC` | `inv.outTemp` | |
| `batterySohPct` | `bms_bmsStatus.soh` | |
| capacity | `bms_bmsStatus.fullCap` × `bms_bmsStatus.vol` | mAh × mV → Wh; left unset if either is missing |

### Solar is not the same as DC input

The DELTA 2 DC input port accepts a solar panel, a car charger *and* the mains
adapter. Counting everything arriving there as solar would inflate generation, so
power on that port is recorded as solar only when `pd.pv1ChargeType` /
`pd.pv2ChargeType` reports `2` (solar panel), or `mppt.chgType` reports `2` (MPPT).

Confirmed adapter input is deliberately **not** counted as solar. It still appears
in battery charge power, so no energy goes missing — it is just not called
generation. If the device reports no charge-type field at all, the power is
counted and the sample is tagged `SOLAR_ATTRIBUTION_UNVERIFIED`.

### Quality flags

Stored per sample in `telemetry_samples.quality_flags`:

| Bit | Meaning |
|---|---|
| 1 | Device was reported offline |
| 2 | SOC came from an integer field only |
| 4 | Solar attribution unverified (no charge-type field) |
| 8 | Battery power derived from input/output totals, not read from the BMS |
| 16 | Repeated reading — identical to the previous poll (see reporting cadence below) |
| 32 | Combined view: not every battery contributed a value |
| 64 | Combined view: a capacity was unknown, so SOC is an unweighted mean |

### Reporting cadence: the cloud is not live

EcoFlow's HTTP API serves **the device's last reported state**, not a live read.
An idle DELTA 2 can go many minutes without reporting, and opening the EcoFlow
mobile app is what prompts a fresh report.

Measured on real hardware: 185 polls at 30-second intervals produced only 13
distinct readings, including one stretch where 59 consecutive polls returned
byte-identical values across 29 minutes. `GET /device/quota/all` and
`POST /device/quota` were compared side by side and returned identical values
every time, so there is no HTTP way to force a fresh read — both endpoints read
the same server-side cache.

Consequences, and how FlowMetrics handles them:

- `observedAt` is when FlowMetrics polled, **not** when the device measured.
  A poll that returns an unchanged payload is flagged `REPEATED_READING` (16),
  and the dashboard shows when the device last reported a *change* rather than
  when it was last polled.
- Energy integration over a flat stretch is only correct if the power really was
  constant. It cannot be distinguished from a device that simply went quiet, so
  treat totals across long repeated stretches as approximate.
- Polling faster does not help; it returns the same cached report more often.
  `ECOFLOW_POLL_INTERVAL_MS` is a latency setting, not a resolution setting.
- MQTT (`/open/${certificateAccount}/${sn}/quota`) would deliver each report the
  moment the device publishes, removing poll latency and API load. It does not
  make the device report more often. The certificate endpoint is implemented in
  the client; the subscription is not.

### Offline devices leave gaps

When the device list reports the battery offline, `quota/all` keeps returning the
last values it saw. Recording those as fresh samples would integrate stale power
into real energy totals, so the collector emits nothing while the device is
offline. The resulting gap is genuine, and the gap-aware integrator excludes it
rather than bridging it.

## Adding another model

1. Run `node scripts/ecoflow-probe.mjs --raw` against the hardware and keep the output.
2. Find that model's `GetAllQuotaResponse` table on the developer portal.
3. Add a mapping module beside `ecoflow-delta2-mapping.ts`, with the documented
   description quoted next to each key.
4. Add tests using the payload from step 1 before wiring it up.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Only one battery appears | `ECOFLOW_SERIAL_NUMBER` pins a single serial — clear it to collect all |
| `rejected the request ... code 6xx` | Signature mismatch — usually a stray space in the secret key |
| Credentials work, empty device list | Device is shared with the account rather than bound to it |
| Collector `degraded`, "Device reported offline" | Battery is off or has no network; this is reported, not hidden |
| All power fields NULL | Model reports different quota keys — run the probe with `--raw` |
