// @effect-diagnostics nodeBuiltinImport:off -- Validate operator-provided public CA certificates at the HTTP transport boundary.
import * as NodeCrypto from "node:crypto";
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
  connectOrigin: Schema.optionalKey(Schema.String),
  controlTls: Schema.optionalKey(
    Schema.Struct({
      hostname: Schema.String,
      bridgeAddress: Schema.String,
      publicCaPem: Schema.String.check(Schema.isMaxLength(16384)),
    }),
  ),
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
    readonly publicCaPem?: string;
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
  if (configuration.connectOrigin !== undefined) {
    const connect = yield* Effect.try({
      try: () => new URL(configuration.connectOrigin!),
      catch: () => new FoundrySandboxError({ code: "invalid_request" }),
    });
    if (
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(configuration.connectOrigin) ||
      connect.origin !== configuration.connectOrigin ||
      !connect.port ||
      configuration.accessFile
    )
      return yield* new FoundrySandboxError({ code: "invalid_request" });
  }
  if (configuration.controlTls) {
    const control = configuration.controlTls;
    yield* Effect.try({
      try: () => {
        if (
          url.port !== "" ||
          control.hostname !== url.hostname ||
          !control.hostname
            .split(".")
            .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
          !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(control.bridgeAddress) ||
          !control.bridgeAddress
            .split(".")
            .every((part) => String(Number(part)) === part && Number(part) <= 255) ||
          control.publicCaPem.length > 16384 ||
          !/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\r?\n?$/.test(
            control.publicCaPem,
          ) ||
          !new NodeCrypto.X509Certificate(control.publicCaPem).ca
        )
          throw new Error("invalid_control_tls");
      },
      catch: () => new FoundrySandboxError({ code: "invalid_request" }),
    });
  }
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
    function* (envelope: unknown, _confirmation = false) {
      const call = yield* HttpClientRequest.post(
        `${configuration.connectOrigin ?? configuration.origin}/api/foundry/devices/channel`,
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
    (effect, _envelope, confirmation) =>
      effect.pipe(Effect.timeout(confirmation ? "120 seconds" : "20 seconds")),
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
      request.op === "archive" || request.op === "setupArchive",
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
        false,
      );
    },
    Effect.mapError(() => new FoundryArtifactError({ code: "unavailable" })),
  );
  return Transport.of({
    device,
    origin: configuration.origin,
    ...(configuration.controlTls ? { publicCaPem: configuration.controlTls.publicCaPem } : {}),
    send,
    artifactSend,
  });
});
export const layer = (configuration: Configuration) => Layer.effect(Transport, make(configuration));
