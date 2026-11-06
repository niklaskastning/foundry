import type { ProviderInstanceId } from "@t3tools/contracts";
import { FoundryProviderConnectionError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";

export class ProviderConnectionAuth extends Context.Service<
  ProviderConnectionAuth,
  {
    readonly currentProfile: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<{ readonly profileKey: string }, FoundryProviderConnectionError>;
    readonly access: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly profileKey: string;
    }) => Effect.Effect<
      {
        readonly accessToken: Redacted.Redacted<string>;
        readonly expiresAt: number;
      },
      FoundryProviderConnectionError
    >;
  }
>()("t3/foundry/ProviderConnectionAuth") {}

const make = Effect.gen(function* () {
  const services =
    yield* Effect.context<
      Exclude<Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>, Scope.Scope>
    >();
  const access = Effect.fn("ProviderConnectionAuth.access")(
    function* (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly profileKey: string;
    }) {
      const auth = yield* makeCodexChatGptAuth({
        instanceId: input.providerInstanceId,
        expectedProfileKey: input.profileKey,
      });
      const credentials = yield* auth.access;
      return {
        accessToken: Redacted.make(credentials.accessToken),
        expiresAt: credentials.expiresAt,
      };
    },
    Effect.scoped,
    Effect.provideContext(services),
    Effect.mapError(() => new FoundryProviderConnectionError({ code: "login_required" })),
  );
  const currentProfile = Effect.fn("ProviderConnectionAuth.currentProfile")(
    function* (providerInstanceId: ProviderInstanceId) {
      const auth = yield* makeCodexChatGptAuth({ instanceId: providerInstanceId });
      const credentials = yield* auth.access;
      return { profileKey: yield* auth.profileKey(credentials) };
    },
    Effect.scoped,
    Effect.provideContext(services),
    Effect.mapError(() => new FoundryProviderConnectionError({ code: "login_required" })),
  );
  return ProviderConnectionAuth.of({ access, currentProfile });
});

export const layer = Layer.effect(ProviderConnectionAuth, make);
