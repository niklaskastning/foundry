import type { AutomationScheduleConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const graceMillis = 10 * 60_000;

const occurrence = (config: AutomationScheduleConfig, day: DateTime.Utc): DateTime.Zoned | null => {
  const hour = Number(config.timeOfDay.slice(0, 2));
  const minute = Number(config.timeOfDay.slice(3, 5));
  const parts = DateTime.toPartsUtc(day);
  if (!config.weekdays.includes(parts.weekDay)) return null;
  const candidate = DateTime.makeZonedUnsafe(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    { timeZone: config.timeZone, adjustForTimeZone: true, disambiguation: "earlier" },
  );
  const actual = DateTime.toParts(candidate);
  return actual.year === parts.year &&
    actual.month === parts.month &&
    actual.day === parts.day &&
    actual.hour === hour &&
    actual.minute === minute
    ? candidate
    : null;
};

const calendarDay = (config: AutomationScheduleConfig, instant: DateTime.DateTime) => {
  const parts = DateTime.toParts(
    DateTime.setZone(instant, DateTime.zoneMakeNamedUnsafe(config.timeZone)),
  );
  return DateTime.makeUnsafe({ year: parts.year, month: parts.month, day: parts.day, hour: 12 });
};

const adjacent = (config: AutomationScheduleConfig, from: DateTime.DateTime, direction: 1 | -1) => {
  const day = calendarDay(config, from);
  const boundary = DateTime.toEpochMillis(from);
  // A weekly occurrence can be absent for one DST gap or skipped civil date.
  for (let offset = 0; offset <= 15; offset += 1) {
    const candidate = occurrence(config, DateTime.add(day, { days: direction * offset }));
    if (!candidate) continue;
    const timestamp = DateTime.toEpochMillis(candidate);
    if (direction === 1 ? timestamp > boundary : timestamp <= boundary) return candidate;
  }
  throw new RangeError("Schedule has no matching weekday.");
};

export const nextScheduleOccurrence = (
  config: AutomationScheduleConfig,
  after: DateTime.DateTime,
) => DateTime.formatIso(adjacent(config, after, 1));

export const planScheduleCatchUp = (
  config: AutomationScheduleConfig,
  nextDueAt: string,
  now: DateTime.DateTime,
) => {
  const first = DateTime.makeUnsafe(nextDueAt);
  const nowMillis = DateTime.toEpochMillis(now);
  if (DateTime.toEpochMillis(first) > nowMillis) return { occurrences: [], nextDueAt };
  const limit = config.catchUp === "bounded" ? Math.min(10, Math.max(1, config.maxCatchUp)) : 1;
  const occurrences: Array<string> = [];
  let cursor = now;
  for (let index = 0; index < limit; index += 1) {
    const candidate = adjacent(config, cursor, -1);
    const millis = DateTime.toEpochMillis(candidate);
    if (millis < DateTime.toEpochMillis(first)) break;
    if (config.catchUp === "skip" && nowMillis - millis > graceMillis) break;
    occurrences.push(DateTime.formatIso(candidate));
    cursor = DateTime.subtractDuration(candidate, 1);
  }
  return { occurrences: occurrences.reverse(), nextDueAt: nextScheduleOccurrence(config, now) };
};
