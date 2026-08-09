/**
 * Local-day boundaries.
 *
 * A "day" for an energy historian is midnight to midnight **where the battery
 * is**, not in UTC. Using UTC midnight shifts every daily total by the zone
 * offset — on Europe/Nicosia in summer that means a "day" running 21:00 to 21:00,
 * silently attributing three hours of each evening to the wrong date.
 *
 * Offsets are resolved through `Intl`, so DST transitions are handled by the
 * platform's tz database rather than a hardcoded offset.
 */

/** ISO calendar date, `YYYY-MM-DD`. */
export type LocalDate = string;

export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: unknown): value is LocalDate {
  return typeof value === "string" && LOCAL_DATE_PATTERN.test(value);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = partsCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsCache.set(timeZone, cached);
  }
  return cached;
}

/** Milliseconds to add to UTC to get wall-clock time in the zone at that instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  // "24" appears at midnight in some locales/engines; normalise it to 0.
  const hour = value("hour") % 24;
  const asIfUtc = Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second"));
  return asIfUtc - instant.getTime();
}

/** The calendar date at a given instant, in the zone. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Today's calendar date in the zone. */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDate {
  return localDateOf(now, timeZone);
}

/**
 * The instant at which the given local date begins in the zone.
 *
 * Resolved by guessing from the naive UTC value and correcting by the offset
 * twice, which settles the case where the guess lands on the far side of a DST
 * transition from the true answer.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Adds (or subtracts) whole calendar days, staying on calendar dates. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Half-open range `[start, end)` covering one local day.
 *
 * The end is the start of the *next* local day rather than start + 24h, so days
 * containing a DST transition are 23 or 25 hours long, as they really are.
 */
export function localDayRange(date: LocalDate, timeZone: string): { start: Date; end: Date } {
  return {
    start: startOfLocalDay(date, timeZone),
    end: startOfLocalDay(addLocalDays(date, 1), timeZone),
  };
}

/** Inclusive list of calendar dates, newest first. */
export function localDatesBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let cursor = to; cursor >= from; cursor = addLocalDays(cursor, -1)) {
    dates.push(cursor);
    if (dates.length > 4000) break; // guard against a malformed range
  }
  return dates;
}
