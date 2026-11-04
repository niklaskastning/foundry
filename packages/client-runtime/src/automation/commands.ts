import type { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AutomationApplicationResult,
  AutomationApplicationError,
  AutomationControlSnapshot,
  AutomationControlError,
  AutomationInboxPage,
  AutomationInboxEntry,
  AutomationInboxError,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";
import type { InstanceBinding } from "../connection/foundry.ts";

export function makeAutomationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  transport: (
    path: string,
    input: unknown,
    environmentId: string,
  ) => Effect.Effect<
    { binding: InstanceBinding; status: number; value: unknown },
    AutomationApplicationError
  >,
) {
  function endpoint<A, I, Failure, FailureEncoded>(
    path: string,
    schema: Schema.Codec<A, I>,
    failureSchema: Schema.Codec<Failure, FailureEncoded>,
    unavailable: () => Failure,
    forbidden: () => Failure,
  ) {
    const decode = Schema.decodeUnknownEffect(schema);
    const decodeFailure = Schema.decodeUnknownEffect(failureSchema);
    return Effect.fn(`Automation.${path}`)(function* (input: unknown) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const response = yield* transport(path, input, supervisor.target.environmentId).pipe(
        Effect.mapError((failure) => (failure.code === "forbidden" ? forbidden() : unavailable())),
      );
      if (response.binding.mainEnvironmentId !== supervisor.target.environmentId)
        return yield* Effect.fail(forbidden());
      if (response.status !== 200) {
        const failure = yield* decodeFailure(response.value).pipe(
          Effect.orElseSucceed(unavailable),
        );
        return yield* Effect.fail(failure);
      }
      return yield* decode(response.value).pipe(Effect.mapError(unavailable));
    });
  }
  const applicationFailure = () => new AutomationApplicationError({ code: "unavailable" });
  const applicationDenied = () => new AutomationApplicationError({ code: "forbidden" });
  return {
    query: createEnvironmentRpcCommand(runtime, {
      label: "foundry:automation:query",
      tag: "foundry.automationQuery",
      execute: endpoint(
        "query",
        AutomationApplicationResult,
        AutomationApplicationError,
        applicationFailure,
        applicationDenied,
      ),
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "foundry:automation:command",
      tag: "foundry.automationCommand",
      execute: endpoint(
        "command",
        AutomationApplicationResult,
        AutomationApplicationError,
        applicationFailure,
        applicationDenied,
      ),
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "foundry:automation:control",
      tag: "foundry.automationControl",
      execute: endpoint(
        "control",
        AutomationControlSnapshot,
        AutomationControlError,
        () => new AutomationControlError({ code: "unavailable" }),
        () => new AutomationControlError({ code: "forbidden" }),
      ),
    }),
    inboxQuery: createEnvironmentRpcCommand(runtime, {
      label: "foundry:automation:inbox-query",
      tag: "foundry.automationInboxQuery",
      execute: endpoint(
        "inbox/query",
        AutomationInboxPage,
        AutomationInboxError,
        () => new AutomationInboxError({ reason: "unavailable" }),
        () => new AutomationInboxError({ reason: "forbidden" }),
      ),
    }),
    inboxMark: createEnvironmentRpcCommand(runtime, {
      label: "foundry:automation:inbox-mark",
      tag: "foundry.automationInboxMark",
      execute: endpoint(
        "inbox/mark",
        AutomationInboxEntry,
        AutomationInboxError,
        () => new AutomationInboxError({ reason: "unavailable" }),
        () => new AutomationInboxError({ reason: "forbidden" }),
      ),
    }),
  };
}
