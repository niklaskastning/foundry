import type { FactoryDefinitionSourceBinding } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DefinitionSources from "./DefinitionSources.ts";
import * as GitHubApp from "./GitHubApp.ts";

export class DefinitionSync extends Context.Service<
  DefinitionSync,
  { readonly tick: Effect.Effect<void, DefinitionSources.DefinitionSourceError> }
>()("t3/automation/DefinitionSync") {}

const make = Effect.gen(function* () {
  const sources = yield* DefinitionSources.DefinitionSources;
  const github = yield* GitHubApp.GitHubApp;
  const sync = Effect.fn("DefinitionSync.sync")(function* (saved: FactoryDefinitionSourceBinding) {
    const current = yield* github.binding(saved.repository);
    if (
      !saved.enabled ||
      current.connectionId !== saved.connectionId ||
      current.repositoryId !== saved.repositoryId ||
      current.repository !== saved.repository ||
      current.generation !== saved.appGeneration
    )
      return yield* new GitHubApp.GitHubAppError({ reason: "forbidden" });
    const result = yield* github.readDefinition({ ...saved, generation: saved.appGeneration });
    yield* sources.accept(saved, result, yield* Clock.currentTimeMillis);
  });
  const recordFailure = Effect.fn("DefinitionSync.recordFailure")(function* (
    binding: FactoryDefinitionSourceBinding,
    reason: string,
    requestedRetryAt?: number,
  ) {
    const failedAt = yield* Clock.currentTimeMillis;
    const retryAt =
      requestedRetryAt !== undefined && Number.isFinite(requestedRetryAt)
        ? Math.min(failedAt + 3_600_000, Math.max(failedAt + 60_000, requestedRetryAt))
        : failedAt + 60_000;
    yield* sources.fail(binding, reason, retryAt);
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const bindings = yield* sources.due(now, 20);
    for (const binding of bindings) {
      yield* sync(binding).pipe(
        Effect.catchTags({
          DefinitionSourceError: (error) =>
            recordFailure(binding, error.reason === "forbidden" ? "forbidden" : "unavailable"),
          GitHubAppError: (error) => recordFailure(binding, error.reason, error.retryAt),
        }),
      );
    }
  }).pipe(Effect.withSpan("DefinitionSync.tick"));
  return DefinitionSync.of({ tick });
});

export const layer = Layer.effect(DefinitionSync, make);
