import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type { AutomationScheduleConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Triggers from "./Triggers.ts";
import * as ScheduleTriggers from "./ScheduleTriggers.ts";

it.effect("reuses occurrence identities when acceptance is retried after service recreation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T12:00:00Z")));
    const config: AutomationScheduleConfig = {
      timeZone: "Europe/Berlin",
      timeOfDay: "09:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      catchUp: "bounded",
      maxCatchUp: 2,
      overlap: "wait",
    };
    const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-01T08:00:00Z"));
    let nextDueAt = start;
    let enabled = true;
    let firstNotCommitted = true;
    const batches: Array<Parameters<Triggers.Triggers["Service"]["acceptScheduledBatch"]>[0]> = [];
    const store = Layer.mock(Triggers.Triggers)({
      dueSchedules: (now) =>
        Effect.succeed(
          enabled && nextDueAt <= now ? [{ id: "binding", generation: 1, config, nextDueAt }] : [],
        ),
      acceptScheduledBatch: (batch) =>
        Effect.sync(() => {
          batches.push(batch);
          if (firstNotCommitted) {
            firstNotCommitted = false;
            return false;
          }
          nextDueAt = batch.nextDueAt;
          return true;
        }),
    });
    const tick = Effect.gen(function* () {
      const service = yield* ScheduleTriggers.ScheduleTriggers;
      return yield* service.tick;
    }).pipe(
      Effect.provide(
        ScheduleTriggers.layer.pipe(Layer.provide(store), Layer.provide(NodeCrypto.layer)),
      ),
    );
    expect(yield* tick).toBe(0);
    expect(yield* tick).toBe(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(batches[0]?.skipped).toBe(1);
    expect(
      batches[0]?.occurrences.map((entry) => DateTime.formatIso(DateTime.makeUnsafe(entry.dueAt))),
    ).toEqual(["2026-11-03T08:00:00.000Z", "2026-11-04T08:00:00.000Z"]);
    expect(new Set(batches[0]?.occurrences.map((entry) => entry.id)).size).toBe(2);
    expect(yield* tick).toBe(0);
    enabled = false;
    yield* TestClock.adjust("1 day");
    expect(yield* tick).toBe(0);
    enabled = true;
    expect(yield* tick).toBe(1);
    expect(batches[2]?.skipped).toBe(0);
  }),
);
