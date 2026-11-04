import { AutomationTriggerError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { planScheduleCatchUp } from "./Schedule.ts";
import * as Triggers from "./Triggers.ts";

export class ScheduleTriggers extends Context.Service<
  ScheduleTriggers,
  {
    readonly tick: Effect.Effect<number, AutomationTriggerError>;
  }
>()("t3/automation/ScheduleTriggers") {}

const encodeOccurrence = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Int, Schema.Number])),
);

const make = Effect.gen(function* () {
  const triggers = yield* Triggers.Triggers;
  const crypto = yield* Crypto.Crypto;
  const tick = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const bindings = yield* triggers.dueSchedules(DateTime.toEpochMillis(now), 50);
    let accepted = 0;
    for (const binding of bindings) {
      const plan = yield* Effect.try({
        try: () =>
          planScheduleCatchUp(
            binding.config,
            DateTime.formatIso(DateTime.makeUnsafe(binding.nextDueAt)),
            now,
          ),
        catch: () => new AutomationTriggerError({ code: "invalid_input" }),
      });
      const occurrences = yield* Effect.forEach(plan.occurrences, (value) =>
        Effect.gen(function* () {
          const dueAt = DateTime.toEpochMillis(DateTime.makeUnsafe(value));
          const digest = yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(
              yield* encodeOccurrence([binding.id, binding.generation, dueAt]),
            ),
          );
          return { id: `schedule:${Hex.encode(digest)}`, dueAt };
        }),
      ).pipe(Effect.mapError(() => new AutomationTriggerError({ code: "unavailable" })));
      const nextDueAt = DateTime.toEpochMillis(DateTime.makeUnsafe(plan.nextDueAt));
      const committed = yield* triggers.acceptScheduledBatch({
        bindingId: binding.id,
        generation: binding.generation,
        expectedNextDueAt: binding.nextDueAt,
        occurrences,
        nextDueAt,
        skipped: (occurrences[0]?.dueAt ?? nextDueAt) > binding.nextDueAt ? 1 : 0,
      });
      if (committed) accepted += occurrences.length;
    }
    return accepted;
  }).pipe(Effect.withSpan("ScheduleTriggers.tick"));
  return ScheduleTriggers.of({ tick });
});

export const layer = Layer.effect(ScheduleTriggers, make);
