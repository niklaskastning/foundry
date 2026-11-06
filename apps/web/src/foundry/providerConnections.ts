import {
  FoundryMain,
  FoundryProviderConnections,
  ConnectionBlockedError,
} from "@t3tools/client-runtime/connection";
import { FoundryProviderConnectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { initialState } from "./onboarding";
import { layerFoundryInstanceSession } from "./instanceSession";

const isProviderError = Schema.is(FoundryProviderConnectionError);
const isConnectionBlocked = Schema.is(ConnectionBlockedError);

export const providerConnectionCommands = FoundryProviderConnections.makeCommands(
  connectionAtomRuntime,
  Effect.fn("FoundryProviderConnections.http")(
    function* (input: unknown, environmentId: string) {
      const binding = initialState().binding;
      if (!binding || binding.mainEnvironmentId !== environmentId)
        return yield* new FoundryProviderConnectionError({ code: "forbidden" });
      const main = yield* FoundryMain.make({
        allowLoopback: import.meta.env.DEV,
        maxResponseBytes: 4 * 1024 * 1024,
      });
      const connection = yield* main.prepare(binding);
      return {
        binding,
        ...(yield* connection.response("/api/foundry/provider-connections", input, true)),
      };
    },
    Effect.provide(Layer.merge(layerFoundryInstanceSession, FetchHttpClient.layer)),
    Effect.mapError((cause) =>
      isProviderError(cause)
        ? cause
        : new FoundryProviderConnectionError({
            code: isConnectionBlocked(cause) ? "forbidden" : "unavailable",
          }),
    ),
  ),
);
