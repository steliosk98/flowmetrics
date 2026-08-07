import type { NormalizedTelemetry } from "./telemetry";

export const POWER_FIELDS = ["solarInputW", "gridInputW", "batteryChargePowerW", "batteryDischargePowerW", "acOutputW", "dcOutputW", "totalOutputW"] as const;
export type PowerField = (typeof POWER_FIELDS)[number];

export interface IntegrationResult {
  energyWh: Record<PowerField, number>;
  validIntegrationSeconds: number;
  gapSeconds: number;
  duplicateCount: number;
  sampleCount: number;
  coveragePct: number;
}

export function integrateTelemetry(samples: NormalizedTelemetry[], options: { expectedIntervalSeconds?: number; absoluteMaxGapSeconds?: number } = {}): IntegrationResult {
  const expected = options.expectedIntervalSeconds ?? 10;
  const maxGap = Math.max(expected * 3, options.absoluteMaxGapSeconds ?? 120);
  const ordered = [...samples].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const unique = ordered.filter((sample, index) => index === 0 || sample.observedAt.getTime() !== ordered[index - 1].observedAt.getTime());
  const energyWh = Object.fromEntries(POWER_FIELDS.map(field => [field, 0])) as Record<PowerField, number>;
  let validIntegrationSeconds = 0;
  let gapSeconds = 0;
  for (let i = 1; i < unique.length; i++) {
    const previous = unique[i - 1];
    const current = unique[i];
    const deltaSeconds = (current.observedAt.getTime() - previous.observedAt.getTime()) / 1000;
    if (deltaSeconds <= 0) continue;
    if (deltaSeconds > maxGap) { gapSeconds += deltaSeconds; continue; }
    validIntegrationSeconds += deltaSeconds;
    for (const field of POWER_FIELDS) {
      const p0 = previous[field]; const p1 = current[field];
      if (p0 == null || p1 == null) continue;
      energyWh[field] += ((p0 + p1) / 2) * (deltaSeconds / 3600);
    }
  }
  const spanSeconds = unique.length > 1 ? (unique.at(-1)!.observedAt.getTime() - unique[0].observedAt.getTime()) / 1000 : 0;
  return { energyWh, validIntegrationSeconds, gapSeconds, duplicateCount: ordered.length - unique.length, sampleCount: unique.length, coveragePct: spanSeconds ? (validIntegrationSeconds / spanSeconds) * 100 : 100 };
}
