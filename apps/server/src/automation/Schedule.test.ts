import type { AutomationScheduleConfig } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { nextScheduleOccurrence, planScheduleCatchUp } from "./Schedule.ts";

const daily: AutomationScheduleConfig = {
  timeZone: "Europe/Berlin",
  timeOfDay: "02:30",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  catchUp: "latest",
  maxCatchUp: 1,
  overlap: "wait",
};

it.effect("skips nonexistent civil times and selects the first repeated time exactly once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-28T01:30:00Z")));
    expect(nextScheduleOccurrence(daily, yield* DateTime.now)).toBe("2026-03-30T00:30:00.000Z");
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T00:30:00Z")));
    expect(nextScheduleOccurrence(daily, yield* DateTime.now)).toBe("2026-10-25T00:30:00.000Z");
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-25T00:30:00Z")));
    expect(nextScheduleOccurrence(daily, yield* DateTime.now)).toBe("2026-10-26T01:30:00.000Z");
    yield* TestClock.adjust("1 hour");
    expect(planScheduleCatchUp(daily, "2026-10-26T01:30:00.000Z", yield* DateTime.now)).toEqual({
      occurrences: [],
      nextDueAt: "2026-10-26T01:30:00.000Z",
    });
    expect(
      nextScheduleOccurrence(
        { ...daily, weekdays: [0] },
        DateTime.makeUnsafe("2026-03-22T01:30:00Z"),
      ),
    ).toBe("2026-04-05T00:30:00.000Z");
  }),
);

it.effect(
  "bounds recovery to the latest configured occurrences and advances beyond the outage",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T12:00:00Z")));
      const now = yield* DateTime.now;
      const first = "2000-01-01T01:30:00.000Z";
      const nextDueAt = "2026-11-05T01:30:00.000Z";
      expect(planScheduleCatchUp({ ...daily, catchUp: "skip" }, first, now)).toEqual({
        occurrences: [],
        nextDueAt,
      });
      expect(planScheduleCatchUp(daily, first, now)).toEqual({
        occurrences: ["2026-11-04T01:30:00.000Z"],
        nextDueAt,
      });
      expect(
        planScheduleCatchUp({ ...daily, catchUp: "bounded", maxCatchUp: 3 }, first, now),
      ).toEqual({
        occurrences: [
          "2026-11-02T01:30:00.000Z",
          "2026-11-03T01:30:00.000Z",
          "2026-11-04T01:30:00.000Z",
        ],
        nextDueAt,
      });
      expect(
        planScheduleCatchUp({ ...daily, catchUp: "bounded", maxCatchUp: 10 }, first, now)
          .occurrences,
      ).toHaveLength(10);
      const recovered = planScheduleCatchUp(
        { ...daily, catchUp: "bounded", maxCatchUp: 3 },
        first,
        now,
      );
      expect(planScheduleCatchUp(daily, recovered.nextDueAt, now).occurrences).toEqual([]);
      expect(
        planScheduleCatchUp(
          { ...daily, catchUp: "bounded", maxCatchUp: 3 },
          "2026-11-04T01:30:00.000Z",
          now,
        ).occurrences,
      ).toEqual(["2026-11-04T01:30:00.000Z"]);
    }),
);

it.effect(
  "honors the grace boundary, weekday, and first occurrence strictly after activation",
  () =>
    Effect.gen(function* () {
      const config = { ...daily, catchUp: "skip" as const, weekdays: [1] };
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-02T01:30:00Z")));
      expect(nextScheduleOccurrence(config, yield* DateTime.now)).toBe("2026-11-09T01:30:00.000Z");
      yield* TestClock.adjust("10 minutes");
      expect(
        planScheduleCatchUp(config, "2026-11-02T01:30:00.000Z", yield* DateTime.now).occurrences,
      ).toEqual(["2026-11-02T01:30:00.000Z"]);
      yield* TestClock.adjust(1);
      expect(
        planScheduleCatchUp(config, "2026-11-02T01:30:00.000Z", yield* DateTime.now).occurrences,
      ).toEqual([]);
    }),
);
