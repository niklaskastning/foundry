import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as AccessConfig from "./AccessConfig.ts";
import * as AccessVerifier from "./AccessVerifier.ts";
import * as FoundrySessions from "./FoundrySessions.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstanceDescriptor from "./InstanceDescriptor.ts";
import * as InstancePersistence from "./InstancePersistence.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as FoundryHttp from "./http.ts";
import * as AuthHttp from "./authHttp.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as DeviceHttp from "./deviceHttp.ts";
import * as DeviceChannel from "./DeviceChannel.ts";
import * as DeviceChannelHttp from "./deviceChannelHttp.ts";
import { FoundryDeviceError } from "@t3tools/contracts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_ACCESS_ENABLED").pipe(Config.withDefault(false));
    const enrollment = yield* Config.Boolean("FOUNDRY_DEVICE_ENROLLMENT_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (enrollment && !enabled) return yield* new FoundryDeviceError({ code: "configuration" });
    const channel = yield* Config.Boolean("FOUNDRY_DEVICE_CHANNEL_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (channel && !enrollment) return yield* new FoundryDeviceError({ code: "configuration" });
    if (!enabled)
      return FoundryHttp.layer.pipe(
        Layer.provide(InstanceDescriptor.layer),
        Layer.provide(InstancePersistence.layer),
        Layer.provide(EnvironmentAuthPolicy.layer),
      );
    const store = yield* Config.String("FOUNDRY_INSTANCE_STORE");
    if (store !== "postgres") return yield* new AccessConfig.AccessConfigurationError({});
    const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
    const deviceRoutes = enrollment
      ? Layer.merge(
          DeviceHttp.layer,
          channel ? DeviceChannelHttp.layer.pipe(Layer.provide(DeviceChannel.layer)) : Layer.empty,
        ).pipe(Layer.provide(DeviceRegistry.layer), Layer.provide(DeviceConfig.layer))
      : Layer.empty;
    return Layer.mergeAll(FoundryHttp.layer, AuthHttp.layer, deviceRoutes).pipe(
      Layer.provide(Layer.merge(InstanceDescriptor.layer, FoundrySessions.layer)),
      Layer.provide(AccessVerifier.layer),
      Layer.provide(AccessVerifier.layerRemoteKeys),
      Layer.provide(AccessConfig.layer),
      Layer.provide(Layer.succeed(AccessConfig.AccessEnabled, true)),
      Layer.provide(Layer.succeed(DeviceConfig.DeviceEnrollmentEnabled, enrollment)),
      Layer.provide(Layer.succeed(DeviceConfig.DeviceChannelEnabled, channel)),
      Layer.provide(InstancePostgres.layerIdentity),
      Layer.provide(InstancePostgres.layer),
      Layer.provide(InstanceDatabase.layer({ url })),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(EnvironmentAuthPolicy.layer),
    );
  }),
);
