import { describe, expect, it } from "vitest";
import { addLocalDays, localDateOf, localDayRange, localDatesBetween, startOfLocalDay, todayIn } from "./day";

const NICOSIA = "Europe/Nicosia";   // UTC+2 winter, UTC+3 summer
const UTC = "UTC";
const CHATHAM = "Pacific/Chatham";  // UTC+12:45 — a non-hour offset

describe("local day boundaries", () => {
  it("starts a summer day at local midnight, not UTC midnight", () => {
    // Europe/Nicosia is UTC+3 in August, so the day begins at 21:00 UTC the day before.
    expect(startOfLocalDay("2026-08-09", NICOSIA).toISOString()).toBe("2026-08-08T21:00:00.000Z");
  });

  it("starts a winter day at the winter offset", () => {
    // UTC+2 in January.
    expect(startOfLocalDay("2026-01-15", NICOSIA).toISOString()).toBe("2026-01-14T22:00:00.000Z");
  });

  it("matches UTC midnight when the zone is UTC", () => {
    expect(startOfLocalDay("2026-08-09", UTC).toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("handles a zone with a 45-minute offset", () => {
    // Chatham is UTC+13:45 in August (southern summer time).
    expect(startOfLocalDay("2026-08-09", CHATHAM).toISOString()).toBe("2026-08-08T11:15:00.000Z");
  });

  it("makes the spring-forward day 23 hours long", () => {
    // EU clocks go forward on the last Sunday of March.
    const { start, end } = localDayRange("2026-03-29", NICOSIA);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it("makes the autumn day 25 hours long", () => {
    const { start, end } = localDayRange("2026-10-25", NICOSIA);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it("ends a day where the next one starts, leaving no gap or overlap", () => {
    const first = localDayRange("2026-08-08", NICOSIA);
    const second = localDayRange("2026-08-09", NICOSIA);
    expect(first.end.getTime()).toBe(second.start.getTime());
  });

  it("assigns an instant to the date it falls on locally", () => {
    // 22:45 UTC on 8 Aug is already 01:45 on 9 Aug in Nicosia — the exact case
    // that made UTC-based rollups file evening samples under the wrong date.
    expect(localDateOf(new Date("2026-08-08T22:45:00Z"), NICOSIA)).toBe("2026-08-09");
    expect(localDateOf(new Date("2026-08-08T22:45:00Z"), UTC)).toBe("2026-08-08");
  });

  it("puts a sample just before local midnight on the earlier date", () => {
    // 20:59 UTC is 23:59 local, still the 8th.
    expect(localDateOf(new Date("2026-08-08T20:59:00Z"), NICOSIA)).toBe("2026-08-08");
    expect(localDateOf(new Date("2026-08-08T21:00:00Z"), NICOSIA)).toBe("2026-08-09");
  });

  it("round-trips a date through its own start instant", () => {
    for (const date of ["2026-01-01", "2026-03-29", "2026-08-09", "2026-10-25", "2026-12-31"]) {
      expect(localDateOf(startOfLocalDay(date, NICOSIA), NICOSIA)).toBe(date);
    }
  });

  it("walks calendar days across month and year ends", () => {
    expect(addLocalDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addLocalDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addLocalDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("lists dates newest first, inclusive of both ends", () => {
    expect(localDatesBetween("2026-08-07", "2026-08-09")).toEqual(["2026-08-09", "2026-08-08", "2026-08-07"]);
    expect(localDatesBetween("2026-08-09", "2026-08-09")).toEqual(["2026-08-09"]);
  });

  it("reports today in the zone, which can differ from the UTC date", () => {
    const instant = new Date("2026-08-08T22:45:00Z");
    expect(todayIn(NICOSIA, instant)).toBe("2026-08-09");
    expect(todayIn(UTC, instant)).toBe("2026-08-08");
  });
});
