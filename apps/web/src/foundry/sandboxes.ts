import {
  FoundryMain,
  FoundrySandboxes,
  ConnectionBlockedError,
} from "@t3tools/client-runtime/connection";
import { FoundrySandboxError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { initialState } from "./onboarding";
import { layerFoundryInstanceSession } from "./instanceSession";

const isSandboxError = Schema.is(FoundrySandboxError);
const isConnectionBlocked = Schema.is(ConnectionBlockedError);

export const sandboxCommands = FoundrySandboxes.makeCommands(
  connectionAtomRuntime,
  Effect.fn("FoundrySandboxes.http")(
    function* (input: unknown, environmentId: string) {
      const binding = initialState().binding;
      if (!binding || binding.mainEnvironmentId !== environmentId)
        return yield* new FoundrySandboxError({ code: "forbidden" });
      const main = yield* FoundryMain.make({
        allowLoopback: import.meta.env.DEV,
        maxResponseBytes: 4 * 1024 * 1024,
      });
      const connection = yield* main.prepare(binding);
      return { binding, ...(yield* connection.response("/api/foundry/sandboxes", input, true)) };
    },
    Effect.provide(Layer.merge(layerFoundryInstanceSession, FetchHttpClient.layer)),
    Effect.mapError((cause) =>
      isSandboxError(cause)
        ? cause
        : new FoundrySandboxError({
            code: isConnectionBlocked(cause) ? "forbidden" : "unavailable",
          }),
    ),
  ),
);
