import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { CodexChatGptCredentials } from "../provider/CodexChatGptAuth.ts";
import * as ProviderConnectionTransport from "./ProviderConnectionTransport.ts";

export const make = Effect.fn("DelegatedCodexAuth.make")(function* (
  instanceId: ProviderInstanceId,
) {
  const transport = yield* ProviderConnectionTransport.ProviderConnectionTransport;
  if (!transport || transport.providerInstanceId !== instanceId)
    return yield* new ProviderSetupError({
      instanceId,
      operation: "connection",
      detail: "This provider is not authorized by the sandbox's central connection.",
    });
  const unavailable = () =>
    new ProviderSetupError({
      instanceId,
      operation: "connection",
      detail: "The central Codex connection is unavailable or revoked. Manage it on Main.",
    });
  const access = transport.access.pipe(
    Effect.map((token): CodexChatGptCredentials => ({
      clientId: transport.connectionId,
      accessToken: Redacted.value(token.accessToken),
      refreshToken: null,
      expiresAt: token.expiresAt,
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      subject: transport.profileKey,
      email: null,
    })),
    Effect.mapError(unavailable),
  );
  const controller = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: `foundry-delegated-${transport.connectionId}` },
    methods: Effect.succeed([]),
    authenticate: () => Effect.fail(unavailable()),
    logout: Effect.fail(unavailable()),
  });
  return {
    controller,
    access,
    read: access.pipe(Effect.asSome),
    profileKey: (_credentials: CodexChatGptCredentials) => Effect.succeed(transport.profileKey),
  };
});
