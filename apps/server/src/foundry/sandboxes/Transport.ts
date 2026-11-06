import {
  FoundryDevice,
  FoundrySandboxError,
  FoundryArtifactError,
  type FoundryArtifactRequest,
  type FoundrySandboxMachineOperation,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http";
import { signArtifactRequest } from "../ArtifactProof.ts";
import { signSandboxRequest } from "./Proof.ts";

export const Configuration = Schema.Struct({
  origin: Schema.String,
  registrationFile: Schema.String,
  keyFile: Schema.String,
  accessFile: Schema.optionalKey(Schema.String),
  networkName: Schema.optionalKey(Schema.String),
  maxCpuMillis: Schema.Int,
  maxMemoryMiB: Schema.Int,
  maxPids: Schema.Int,
  socketPath: Schema.optionalKey(Schema.String),
});
export type Configuration = typeof Configuration.Type;
export class Transport extends Context.Service<
  Transport,
  {
    readonly artifactSend: (
      request: FoundryArtifactRequest,
    ) => Effect.Effect<unknown, FoundryArtifactError>;
    readonly device: FoundryDevice;
    readonly origin: string;
    readonly send: (
      request: FoundrySandboxMachineOperation,
    ) => Effect.Effect<unknown, FoundrySandboxError>;
  }
>()("t3/foundry/sandboxes/Transport") {}
const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const DeviceKey = Schema.Struct({ privateKey: Schema.String });
const Access = Schema.Struct({
  origin: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.String,
});
const decodeError = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundrySandboxError.fields.code }),
);
const isError = Schema.is(FoundrySandboxError);
const make = Effect.fn("SandboxTransport.make")(function* (configuration: Configuration) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const read = Effect.fn("SandboxTransport.read")(function* (file: string) {
    if (!file.startsWith("/") || (yield* fs.stat(file)).size > 16384n)
      return yield* new FoundrySandboxError({ code: "invalid_request" });
    return yield* json(yield* fs.readFileString(file));
  });
  const url = yield* Effect.try({
    try: () => new URL(configuration.origin),
    catch: () => new FoundrySandboxError({ code: "invalid_request" }),
  });
  if (url.protocol !== "https:" || url.origin !== configuration.origin)
    return yield* new FoundrySandboxError({ code: "invalid_request" });
  const device = yield* read(configuration.registrationFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FoundryDevice)),
  );
  const key = yield* read(configuration.keyFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DeviceKey)),
    Effect.map((value) => Redacted.make(value.privateKey)),
  );
  const access = configuration.accessFile
    ? yield* read(configuration.accessFile).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Access)))
    : undefined;
  if (access && access.origin !== configuration.origin)
    return yield* new FoundrySandboxError({ code: "forbidden" });
  const post = Effect.fn("SandboxTransport.post")(
    function* (envelope: unknown) {
      const call = yield* HttpClientRequest.post(
        `${configuration.origin}/api/foundry/devices/channel`,
      ).pipe(
        HttpClientRequest.bodyJson(envelope),
        Effect.map((value) =>
          access
            ? value.pipe(
                HttpClientRequest.setHeaders({
                  "CF-Access-Client-Id": access.clientId,
                  "CF-Access-Client-Secret": access.clientSecret,
                }),
              )
            : value,
        ),
      );
      const response = yield* http.execute(call).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
        }),
        Effect.provideService(Headers.CurrentRedactedNames, [
          ...(yield* Headers.CurrentRedactedNames),
          "cf-access-client-id",
          "cf-access-client-secret",
        ]),
      );
      const decoder = new TextDecoder();
      const result = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => ({ text: "", length: 0 }),
          (state, chunk) =>
            state.length + chunk.byteLength > 2097152
              ? Effect.fail(new FoundrySandboxError({ code: "invalid_request" }))
              : Effect.succeed({
                  text: state.text + decoder.decode(chunk, { stream: true }),
                  length: state.length + chunk.byteLength,
                }),
        ),
      );
      const text = result.text + decoder.decode();
      const body = yield* json(text);
      if (response.status !== 200) {
        const error = yield* decodeError(body);
        return yield* new FoundrySandboxError({ code: error.code });
      }
      return body;
    },
    Effect.timeout("20 seconds"),
    Effect.mapError((error) =>
      isError(error) ? error : new FoundrySandboxError({ code: "unavailable" }),
    ),
  );
  const send = Effect.fn("SandboxTransport.send")(function* (
    request: FoundrySandboxMachineOperation,
  ) {
    return yield* post(
      signSandboxRequest(
        configuration.origin,
        device,
        yield* Clock.currentTimeMillis,
        request,
        Redacted.value(key),
      ),
    );
  });
  const artifactSend = Effect.fn("SandboxTransport.artifactSend")(
    function* (request: FoundryArtifactRequest) {
      return yield* post(
        signArtifactRequest(
          configuration.origin,
          device,
          yield* Clock.currentTimeMillis,
          request,
          Redacted.value(key),
        ),
      );
    },
    Effect.mapError(() => new FoundryArtifactError({ code: "unavailable" })),
  );
  return Transport.of({ device, origin: configuration.origin, send, artifactSend });
});
export const layer = (configuration: Configuration) => Layer.effect(Transport, make(configuration));
