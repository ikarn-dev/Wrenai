import type { z } from "zod";
import type { dcaScheduleSchema } from "@/shared/agent-instructions";

type Schedule = z.infer<typeof dcaScheduleSchema>;
export interface DcaSlot {
  readonly key: string;
  readonly dueAt: number;
}
interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}
function localDate(format: Intl.DateTimeFormat, instant: number): LocalDate {
  const parts = format.formatToParts(instant);
  const part = (type: string): number => {
    const text = parts.find((value) => value.type === type)?.value;
    if (text === undefined) {
      throw new Error("The timezone calendar could not be read.");
    }
    return Number(text);
  };
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}
function utc(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute);
}

/** Returns the first occurrence of a local wall time. Nonexistent spring-forward times are skipped. */
function calendarInstant(format: Intl.DateTimeFormat, target: LocalDate): number | null {
  const naive = utc(target);
  const candidates = [-86_400_000, 0, 86_400_000]
    .map((delta) => {
      const sample = naive + delta;
      const offset = utc(localDate(format, sample)) - sample;
      return naive - offset;
    })
    .filter((instant) => utc(localDate(format, instant)) === naive)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

/** Stable slot IDs outlive workflow restarts. A delayed worker skips slots over one minute old. */
export function dcaScheduleSlot(
  schedule: Schedule,
  now: number,
): { readonly due: DcaSlot | null; readonly nextAt: number } {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new RangeError("Invalid schedule time.");
  }
  if (schedule.type === "interval") {
    const start = Date.parse(schedule.startAt);
    const interval = schedule.intervalSeconds * 1000;
    if (now < start) {
      return { due: null, nextAt: start };
    }
    const slot = Math.floor((now - start) / interval);
    const dueAt = start + slot * interval;
    return {
      due: now - dueAt < 60_000 ? { key: `interval:${start}:${slot}`, dueAt } : null,
      nextAt: dueAt + interval,
    };
  }
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const today = localDate(format, now);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const candidates: DcaSlot[] = [];
  for (let offset = -1; offset <= 8; offset += 1) {
    const day = new Date(todayUtc + offset * 86_400_000);
    if (!schedule.weekdays.includes(day.getUTCDay())) {
      continue;
    }
    const target = {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: schedule.hour,
      minute: schedule.minute,
    };
    const instant = calendarInstant(format, target);
    if (instant === null) {
      continue;
    }
    const dateKey = `${target.year}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`;
    candidates.push({
      key: `calendar:${schedule.timezone}:${dateKey}:${schedule.hour}:${schedule.minute}`,
      dueAt: instant,
    });
  }
  const previous = candidates.filter((slot) => slot.dueAt <= now).sort((a, b) => b.dueAt - a.dueAt)[0];
  const next = candidates.filter((slot) => slot.dueAt > now).sort((a, b) => a.dueAt - b.dueAt)[0];
  if (!next) {
    throw new Error("No next calendar slot was found within the bounded schedule window.");
  }
  return { due: previous && now - previous.dueAt < 60_000 ? previous : null, nextAt: next.dueAt };
}

/** Whole seconds until the next schedule slot, between one and sixty: DCA checks wake at the slot itself. */
export function dcaWaitSeconds(schedule: Schedule, now: number): number {
  return Math.max(1, Math.min(60, Math.ceil((dcaScheduleSlot(schedule, now).nextAt - now) / 1000)));
}
