import {
  EnvironmentId,
  FoundryDevice,
  FoundryDeviceError,
  type FoundryGatewayGrant,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as StreamBridge from "../foundry/StreamBridge.ts";
import * as StreamSocket from "../foundry/StreamSocket.ts";
import { FoundryGatewayError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DeviceHttpAdapter from "../foundry/DeviceHttpAdapter.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";
import * as DeviceConnector from "../foundry/DeviceConnector.ts";

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRegistration = Schema.decodeUnknownEffect(FoundryDevice);
const decodeKey = Schema.decodeUnknownEffect(Schema.Struct({ privateKey: Schema.String }));
const decodeAccess = Schema.decodeUnknownEffect(
  Schema.Struct({
    origin: Schema.String,
    clientId: Schema.NonEmptyString,
    clientSecret: Schema.NonEmptyString,
  }),
);
const decodeEnvironment = Schema.decodeUnknownEffect(EnvironmentId);
const readJson = Effect.fn("foundry.connectDevice.readJson")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.stat(file)).size > 8192n)
      return yield* new FoundryDeviceError({ code: "configuration" });
    return yield* parseJson(yield* fs.readFileString(file));
  },
  Effect.mapError(() => new FoundryDeviceError({ code: "configuration" })),
);

export const connectDeviceCommand = Command.make("connect-device", {
  baseDir: Flag.String("base-dir"),
  origin: Flag.String("origin"),
  registration: Flag.String("registration"),
  keyFile: Flag.String("key-file"),
  gatewayOrigin: Flag.String("gateway-origin").pipe(Flag.optional),
  streams: Flag.Boolean("streams"),
  accessFile: Flag.String("access-file").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Run the outgoing Foundry device channel for one existing local environment. Starts no backend or provider.",
  ),
  Command.withHandler(
    Effect.fn("foundry.connectDevice")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const device = yield* decodeRegistration(yield* readJson(flags.registration)).pipe(
        Effect.mapError(() => new FoundryDeviceError({ code: "configuration" })),
      );
      const key = yield* decodeKey(yield* readJson(flags.keyFile)).pipe(
        Effect.mapError(() => new FoundryDeviceError({ code: "configuration" })),
      );
      const access = Option.isSome(flags.accessFile)
        ? yield* decodeAccess(yield* readJson(flags.accessFile.value)).pipe(
            Effect.mapError(() => new FoundryDeviceError({ code: "configuration" })),
          )
        : undefined;
      const socket = yield* DeviceConnector.makeSocket(
        flags.origin,
        access
          ? {
              origin: access.origin,
              clientId: Redacted.make(access.clientId),
              clientSecret: Redacted.make(access.clientSecret),
            }
          : undefined,
      );
      const localEnvironmentId = fs
        .readFileString(path.join(flags.baseDir, "userdata", "environment-id"))
        .pipe(
          Effect.flatMap((value) => decodeEnvironment(value.trim())),
          Effect.mapError(() => new FoundryDeviceError({ code: "configuration" })),
        );
      const options = {
        origin: flags.origin,
        device,
        privateKey: Redacted.make(key.privateKey),
        localEnvironmentId,
        connected: Console.log(
          `Foundry device ${device.deviceId} connected; project-read adapter ${Option.isSome(flags.gatewayOrigin) ? "enabled" : "disabled"}.`,
        ),
      };
      if (flags.streams && Option.isNone(flags.gatewayOrigin))
        return yield* new FoundryDeviceError({ code: "configuration" });
      if (Option.isNone(flags.gatewayOrigin)) return yield* DeviceConnector.run(socket, options);
      if ((yield* localEnvironmentId) !== device.environmentId)
        return yield* new FoundryDeviceError({ code: "configuration" });
      const localOrigin = flags.gatewayOrigin.value;
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(flags.baseDir) },
        yield* GlobalFlag.LogLevel,
      );
      return yield* Effect.gen(function* () {
        const adapter = yield* DeviceHttpAdapter.make({ ...options, localOrigin });
        return yield* DeviceConnector.run(socket, {
          ...options,
          projects: adapter.projects,
          ...(flags.streams
            ? {
                stream: Effect.fn("foundry.connectDevice.stream")(function* (
                  grant: FoundryGatewayGrant,
                  generation: number,
                  ticket: string,
                ) {
                  const local = yield* adapter.openStream(grant, generation);
                  const remote = yield* StreamSocket.connect(
                    `${flags.origin.replace(/^https:/, "wss:")}/api/foundry/devices/stream`,
                    {
                      "x-foundry-stream-ticket": ticket,
                      ...(access
                        ? {
                            "CF-Access-Client-Id": access.clientId,
                            "CF-Access-Client-Secret": access.clientSecret,
                          }
                        : {}),
                    },
                  ).pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
                  return yield* StreamBridge.bridge(
                    local,
                    remote,
                    Effect.gen(function* () {
                      if (
                        grant.expiresAt <= (yield* Clock.currentTimeMillis) ||
                        (yield* localEnvironmentId.pipe(
                          Effect.mapError(() => new FoundryGatewayError({ code: "forbidden" })),
                        )) !== grant.environmentId
                      )
                        return yield* new FoundryGatewayError({ code: "forbidden" });
                    }),
                  );
                }, Effect.scoped),
              }
            : {}),
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            FetchHttpClient.layer,
            SessionStore.layer.pipe(
              Layer.provide(SqlitePersistence.layerConfig),
              Layer.provide(ServerSecretStore.layer),
              Layer.provideMerge(ServerEnvironment.layerIdentity),
              Layer.provide(ServerConfig.layer(config)),
            ),
          ),
        ),
      );
    }),
  ),
);
