import {
  FoundryProviderConnectionMutationResult,
  FoundryProviderConnectionError,
  FoundryProviderConnectionListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./registry.ts";
import { EnvironmentSupervisor } from "./supervisor.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";
import type { InstanceBinding } from "./foundry.ts";

const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundryProviderConnectionError.fields.code }),
);

export function makeCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  transport: (
    input: unknown,
    environmentId: string,
  ) => Effect.Effect<
    { binding: InstanceBinding; status: number; value: unknown },
    FoundryProviderConnectionError
  >,
) {
  function endpoint<A, I>(schema: Schema.Codec<A, I>) {
    return Effect.fn("FoundryProviderConnections.request")(function* (input: unknown) {
      const supervisor = yield* EnvironmentSupervisor;
      const response = yield* transport(input, supervisor.target.environmentId);
      if (response.binding.mainEnvironmentId !== supervisor.target.environmentId)
        return yield* new FoundryProviderConnectionError({ code: "forbidden" });
      if (response.status !== 200) {
        const failure = yield* decodeFailure(response.value).pipe(
          Effect.orElseSucceed(() => ({ code: "unavailable" as const })),
        );
        return yield* new FoundryProviderConnectionError(failure);
      }
      return yield* Schema.decodeUnknownEffect(schema)(response.value).pipe(
        Effect.mapError(() => new FoundryProviderConnectionError({ code: "unavailable" })),
      );
    });
  }
  return {
    query: createEnvironmentRpcCommand(runtime, {
      label: "foundry:provider-connections:query",
      tag: "foundry.providerConnectionQuery",
      execute: endpoint(FoundryProviderConnectionListResult),
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "foundry:provider-connections:command",
      tag: "foundry.providerConnectionCommand",
      execute: endpoint(FoundryProviderConnectionMutationResult),
    }),
  };
}
