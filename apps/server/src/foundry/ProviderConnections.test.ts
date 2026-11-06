import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import * as ProviderConnectionAuth from "./ProviderConnectionAuth.ts";

it.effect("delegates only the selected profile's access token and actual upstream expiry", () =>
  Effect.gen(function* () {
    const bytes = new Map<string, Uint8Array>();
    const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          bytes.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          bytes.delete(name);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const dependencies = Layer.mergeAll(
      secrets,
      NodeServices.layer,
      FetchHttpClient.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("central-auth-test")),
      }),
    );
    yield* Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("central-codex");
      const credentials = {
        clientId: "oaiapp_test",
        accessToken: "fixture-access-not-a-real-token",
        refreshToken: "fixture-refresh-must-stay-central",
        expiresAt: 3_600_000,
        earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "fixture-subject",
        email: null,
      };
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", providerInstanceId);
      yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
      const auth = yield* makeCodexChatGptAuth({ instanceId: providerInstanceId });
      const profileKey = yield* auth.profileKey(credentials);
      const service = yield* ProviderConnectionAuth.ProviderConnectionAuth;
      const selected = yield* service.currentProfile(providerInstanceId);
      assert.deepStrictEqual(selected, { profileKey });
      assert.isFalse(JSON.stringify(selected).includes(credentials.accessToken));
      const issued = yield* service.access({ providerInstanceId, profileKey });
      assert.deepStrictEqual(Object.keys(issued).sort(), ["accessToken", "expiresAt"]);
      assert.strictEqual(Redacted.value(issued.accessToken), credentials.accessToken);
      assert.strictEqual(issued.expiresAt, credentials.expiresAt);
      assert.isFalse(JSON.stringify(issued).includes(credentials.accessToken));
      assert.isFalse(JSON.stringify(issued).includes(credentials.refreshToken));
      const changed = yield* service
        .access({ providerInstanceId, profileKey: "0".repeat(64) })
        .pipe(Effect.result);
      assert.strictEqual(changed._tag, "Failure");
      if (changed._tag === "Failure") assert.strictEqual(changed.failure.code, "login_required");
      const missing = yield* service
        .access({ providerInstanceId: ProviderInstanceId.make("unselected"), profileKey })
        .pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      const missingProfile = yield* service
        .currentProfile(ProviderInstanceId.make("unselected"))
        .pipe(Effect.result);
      assert.strictEqual(missingProfile._tag, "Failure");
    }).pipe(Effect.provide(ProviderConnectionAuth.layer.pipe(Layer.provideMerge(dependencies))));
  }).pipe(Effect.scoped),
);
