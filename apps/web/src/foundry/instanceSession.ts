import { FoundryInstanceSession, ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { executeInstanceOperation } from "./onboarding";

export const layerFoundryInstanceSession = Layer.succeed(FoundryInstanceSession, {
  current: Effect.fn("FoundryInstanceSession.current")((binding) =>
    Effect.tryPromise({
      try: async () => {
        if (window.location.origin !== binding.origin) throw new Error("Origin mismatch");
        const result = await executeInstanceOperation({ operation: "session" });
        if (!result.confirmed || !result.binding || !result.session)
          throw new Error("Session required");
        return {
          binding: result.binding,
          csrfToken: result.session.csrfToken,
          authorization: null,
        };
      },
      catch: () =>
        new ConnectionBlockedError({
          reason: "authentication",
          detail: "Open /foundry on this instance to verify its identity and sign in.",
        }),
    }),
  ),
});
