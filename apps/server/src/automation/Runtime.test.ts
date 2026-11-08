import * as Evaluations from "./Evaluations.ts";
import * as DefinitionSync from "./DefinitionSync.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as GitHubPolling from "./GitHubPolling.ts";
import * as Runtime from "./Runtime.ts";
import * as Scheduler from "./Scheduler.ts";
import * as ScheduleTriggers from "./ScheduleTriggers.ts";
import * as Triggers from "./Triggers.ts";

it.effect(
  "keeps dispatch reconciliation progressing while connector, evaluation and admission I/O are blocked",
  () =>
    Effect.gen(function* () {
      const pollStarted = yield* Deferred.make<void>();
      const admissionStarted = yield* Deferred.make<void>();
      const evaluationStarted = yield* Deferred.make<void>();
      const releaseInputs = yield* Deferred.make<void>();
      const dispatches = yield* Queue.unbounded<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(DefinitionSync.DefinitionSync)({ tick: Effect.void }),
        Layer.mock(Evaluations.Evaluations)({
          tick: Deferred.succeed(evaluationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseInputs)),
          ),
        }),
        Layer.mock(GitHubPolling.GitHubPolling)({
          tick: Deferred.succeed(pollStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseInputs)),
            Effect.as(0),
          ),
        }),
        Layer.mock(Triggers.Triggers)({
          tick: Deferred.succeed(admissionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseInputs)),
            Effect.as(0),
          ),
        }),
        Layer.mock(ScheduleTriggers.ScheduleTriggers)({ tick: Effect.succeed(0) }),
        Layer.mock(Scheduler.Scheduler)({
          tick: Queue.offer(dispatches, undefined).pipe(Effect.as(true)),
        }),
      );
      yield* Layer.build(Runtime.reconciliationLayer.pipe(Layer.provide(dependencies)));
      yield* Deferred.await(pollStarted);
      yield* Deferred.await(admissionStarted);
      yield* Deferred.await(evaluationStarted);
      yield* Queue.take(dispatches);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(dispatches);
      expect(yield* Deferred.isDone(releaseInputs)).toBe(false);
      yield* Deferred.succeed(releaseInputs, undefined);
    }).pipe(Effect.scoped),
);
