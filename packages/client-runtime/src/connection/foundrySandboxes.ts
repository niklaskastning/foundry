import {
  FoundrySandboxAllocation,
  FoundrySandboxDetail,
  FoundrySandboxError,
  FoundrySandboxListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "./registry.ts";
import { EnvironmentSupervisor } from "./supervisor.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";
import type { InstanceBinding } from "./foundry.ts";

const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundrySandboxError.fields.code }),
);

export function makeCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  transport: (
    input: unknown,
    environmentId: string,
  ) => Effect.Effect<
    { binding: InstanceBinding; status: number; value: unknown },
    FoundrySandboxError
  >,
) {
  function endpoint<A, I>(schema: Schema.Codec<A, I>) {
    return Effect.fn("FoundrySandboxes.request")(function* (input: unknown) {
      const supervisor = yield* EnvironmentSupervisor;
      const response = yield* transport(input, supervisor.target.environmentId);
      if (response.binding.mainEnvironmentId !== supervisor.target.environmentId)
        return yield* new FoundrySandboxError({ code: "forbidden" });
      if (response.status !== 200) {
        const failure = yield* decodeFailure(response.value).pipe(
          Effect.orElseSucceed(() => ({ code: "unavailable" as const })),
        );
        return yield* new FoundrySandboxError(failure);
      }
      return yield* Schema.decodeUnknownEffect(schema)(response.value).pipe(
        Effect.mapError(() => new FoundrySandboxError({ code: "unavailable" })),
      );
    });
  }
  return {
    query: createEnvironmentRpcCommand(runtime, {
      label: "foundry:sandboxes:query",
      tag: "foundry.sandboxQuery",
      execute: endpoint(Schema.Union([FoundrySandboxListResult, FoundrySandboxDetail])),
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "foundry:sandboxes:command",
      tag: "foundry.sandboxCommand",
      execute: endpoint(FoundrySandboxAllocation),
    }),
  };
}
