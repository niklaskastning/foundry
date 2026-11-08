import { makeAutomationCommands } from "@t3tools/client-runtime/automation/commands";
import { FoundryMain, ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { FetchHttpClient } from "effect/http";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../../connection/runtime";
import { AutomationApplicationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { initialState } from "../../foundry/onboarding";
import { layerFoundryInstanceSession } from "../../foundry/instanceSession";

const isApplicationError = Schema.is(AutomationApplicationError);
const isConnectionBlocked = Schema.is(ConnectionBlockedError);

export const automationCommands = makeAutomationCommands(
  connectionAtomRuntime,
  Effect.fn("Automation.request")(
    function* (path: string, input: unknown, environmentId: string) {
      const binding = initialState().binding;
      if (!binding || binding.mainEnvironmentId !== environmentId)
        return yield* new AutomationApplicationError({ code: "forbidden" });
      const definitionTransfer =
        typeof input === "object" &&
        input !== null &&
        "op" in input &&
        [
          "factory",
          "definitionRevision",
          "definitionRevisionFile",
          "runtimeNode",
          "activateDefinition",
          "activateDefinitionRevision",
        ].includes(String(input.op));
      const main = yield* FoundryMain.make({
        allowLoopback: import.meta.env.DEV,
        maxResponseBytes: (definitionTransfer ? 64 : 3) * 1024 * 1024,
      });
      const connection = yield* main.prepare(binding);
      const response = yield* connection.response(`/api/foundry/automation/${path}`, input, true);
      return { binding, ...response };
    },
    Effect.provide(Layer.merge(layerFoundryInstanceSession, FetchHttpClient.layer)),
    Effect.mapError((cause) =>
      isApplicationError(cause)
        ? cause
        : new AutomationApplicationError({
            code: isConnectionBlocked(cause) ? "forbidden" : "unavailable",
          }),
    ),
  ),
);
