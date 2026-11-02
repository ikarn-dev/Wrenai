import { describe, expect, it } from "vitest";
import { dcaScheduleSlot } from "@/server/engine/dca-schedule";

const calendar = {
  type: "calendar",
  timezone: "America/New_York",
  hour: 1,
  minute: 30,
  weekdays: [0],
} as const;
describe("durable DCA schedule slots", () => {
  it("has stable interval identities and skips delayed slots without catch-up", () => {
    const schedule = { type: "interval", startAt: "2026-11-01T00:00:00Z", intervalSeconds: 300 } as const;
    const start = Date.parse(schedule.startAt);
    expect(dcaScheduleSlot(schedule, start - 1).due).toBeNull();
    expect(dcaScheduleSlot(schedule, start + 59_999).due?.key).toBe(
      dcaScheduleSlot(schedule, start).due?.key,
    );
    expect(dcaScheduleSlot(schedule, start + 60_000).due).toBeNull();
    expect(dcaScheduleSlot(schedule, start + 301_000).due?.key).not.toBe(
      dcaScheduleSlot(schedule, start).due?.key,
    );
    expect(dcaScheduleSlot(schedule, start + 240_000).nextAt).toBe(start + 300_000);
  });
  it("executes only the first occurrence of a repeated autumn wall time", () => {
    const first = dcaScheduleSlot(
      { ...calendar, weekdays: [...calendar.weekdays] },
      Date.parse("2026-11-01T05:30:15Z"),
    );
    expect(first.due?.key).toContain("2026-11-01:1:30");
    const second = dcaScheduleSlot(
      { ...calendar, weekdays: [...calendar.weekdays] },
      Date.parse("2026-11-01T06:30:15Z"),
    );
    expect(second.due).toBeNull();
    expect(second.nextAt).toBe(Date.parse("2026-11-08T06:30:00Z"));
  });
  it("skips nonexistent spring times and preserves the requested timezone", () => {
    const schedule = { ...calendar, hour: 2, weekdays: [...calendar.weekdays] };
    const result = dcaScheduleSlot(schedule, Date.parse("2026-03-08T07:30:00Z"));
    expect(result.due).toBeNull();
    expect(result.nextAt).toBe(Date.parse("2026-03-15T06:30:00Z"));
    expect(
      dcaScheduleSlot(
        { type: "calendar", timezone: "Asia/Kolkata", hour: 9, minute: 0, weekdays: [1] },
        Date.parse("2026-11-02T03:30:15Z"),
      ).due?.dueAt,
    ).toBe(Date.parse("2026-11-02T03:30:00Z"));
  });
});
