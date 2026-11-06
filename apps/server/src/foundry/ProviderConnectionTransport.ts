import {
  FoundryDevice,
  FoundryProviderConnectionError,
  FoundryProviderIssue,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { signProviderRequest } from "./ProviderConnectionProof.ts";

export class ProviderConnectionTransport extends Context.Reference<
  | {
      readonly providerInstanceId: ProviderInstanceId;
      readonly profileKey: string;
      readonly connectionId: string;
      readonly access: Effect.Effect<
        { readonly accessToken: Redacted.Redacted<string>; readonly expiresAt: number },
        FoundryProviderConnectionError
      >;
    }
  | undefined
>("t3/foundry/ProviderConnectionTransport", { defaultValue: () => undefined }) {}

const Binding = Schema.Struct({
  ...FoundryProviderIssue.fields,
  origin: Schema.String,
  registrationFile: Schema.String,
  keyFile: Schema.String,
  accessFile: Schema.optionalKey(Schema.String),
  providerInstanceId: ProviderInstanceId,
  profileKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeBinding = Schema.decodeUnknownEffect(Binding, { onExcessProperty: "error" });
const decodeDevice = Schema.decodeUnknownEffect(FoundryDevice);
const decodeKey = Schema.decodeUnknownEffect(Schema.Struct({ privateKey: Schema.NonEmptyString }));
const decodeAccess = Schema.decodeUnknownEffect(
  Schema.Struct({
    origin: Schema.String,
    clientId: Schema.NonEmptyString,
    clientSecret: Schema.NonEmptyString,
  }),
);
const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      accessToken: Schema.NonEmptyString.check(Schema.isMaxLength(60_000)),
      expiresAt: Schema.Finite,
    }),
  ),
);
const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isConnectionError = Schema.is(FoundryProviderConnectionError);
const unavailable = () => new FoundryProviderConnectionError({ code: "unavailable" });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const bindingFile = yield* Config.String("FOUNDRY_PROVIDER_CONNECTION_BINDING_FILE").pipe(
      Config.withDefault(""),
    );
    if (!bindingFile) return Layer.empty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const readJson = Effect.fn("ProviderConnectionTransport.readConfiguration")(function* (
      name: string,
    ) {
      const stat = yield* fs.stat(name);
      if (!path.isAbsolute(name) || stat.size > 16_384n) return yield* unavailable();
      return yield* parseJson(yield* fs.readFileString(name));
    }, Effect.mapError(unavailable));
    const binding = yield* readJson(bindingFile).pipe(
      Effect.flatMap(decodeBinding),
      Effect.mapError(unavailable),
    );
    const device = yield* readJson(binding.registrationFile).pipe(
      Effect.flatMap(decodeDevice),
      Effect.mapError(unavailable),
    );
    const key = yield* readJson(binding.keyFile).pipe(
      Effect.flatMap(decodeKey),
      Effect.mapError(unavailable),
    );
    const privateKey = Redacted.make(key.privateKey);
    const access = binding.accessFile
      ? yield* readJson(binding.accessFile).pipe(
          Effect.flatMap(decodeAccess),
          Effect.mapError(unavailable),
        )
      : undefined;
    if (
      !URL.canParse(binding.origin) ||
      new URL(binding.origin).origin !== binding.origin ||
      new URL(binding.origin).protocol !== "https:" ||
      device.environmentId !== (yield* identity.getEnvironmentId) ||
      device.revoked ||
      (access && access.origin !== binding.origin)
    )
      return yield* unavailable();
    const headers = access
      ? { "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret }
      : {};
    const redactedHeaders = yield* Headers.CurrentRedactedNames;
    const issue = Effect.fn("ProviderConnectionTransport.issue")(
      function* () {
        const issuedAt = yield* Clock.currentTimeMillis;
        const request = yield* Effect.try({
          try: () =>
            signProviderRequest(
              binding.origin,
              device,
              issuedAt,
              {
                connectionId: binding.connectionId,
                connectionGeneration: binding.connectionGeneration,
                allocationId: binding.allocationId,
                factoryId: binding.factoryId,
              },
              Redacted.value(privateKey),
            ),
          catch: unavailable,
        });
        const req = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${binding.origin}/api/foundry/devices/channel`, {
            headers: { "content-type": "application/json", ...headers },
          }),
          request,
        );
        const response = yield* http.execute(req).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
          }),
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...redactedHeaders,
            "cf-access-client-id",
            "cf-access-client-secret",
          ]),
        );
        if (response.status === 403)
          return yield* new FoundryProviderConnectionError({ code: "forbidden" });
        if (
          response.status !== 200 ||
          !response.headers["content-type"]?.includes("application/json")
        )
          return yield* unavailable();
        const bytes = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ data: "", length: 0 }),
            (state, chunk) => {
              if (state.length + chunk.length > 65_536) return Effect.fail(unavailable());
              return Effect.succeed({
                data: state.data + new TextDecoder().decode(chunk),
                length: state.length + chunk.length,
              });
            },
          ),
        );
        const token = yield* decodeResponse(bytes.data);
        if (token.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* new FoundryProviderConnectionError({ code: "login_required" });
        return { accessToken: Redacted.make(token.accessToken), expiresAt: token.expiresAt };
      },
      Effect.timeout("80 seconds"),
      Effect.mapError((error) => (isConnectionError(error) ? error : unavailable())),
    );
    return Layer.succeed(ProviderConnectionTransport, {
      providerInstanceId: binding.providerInstanceId,
      profileKey: binding.profileKey,
      connectionId: binding.connectionId,
      access: issue(),
    });
  }),
);
