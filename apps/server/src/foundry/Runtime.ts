import * as WorkerTransport from "../automation/WorkerTransport.ts";
import * as SandboxGatewayAccess from "./SandboxGatewayAccess.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProviderConnectionAccess from "./ProviderConnectionAccess.ts";
import * as ProviderConnections from "./ProviderConnections.ts";
import * as ProviderConnectionAuth from "./ProviderConnectionAuth.ts";
import * as SandboxRuntime from "./sandboxes/Runtime.ts";
import * as MachineCredentials from "./MachineCredentials.ts";
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
import * as DeviceGrants from "./DeviceGrants.ts";
import * as GatewayGrants from "./GatewayGrants.ts";
import * as GatewayHttp from "./gatewayHttp.ts";
import { FoundryDeviceError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ArtifactFiles from "./ArtifactFiles.ts";
import * as Artifacts from "./Artifacts.ts";
import * as ArtifactAccess from "./ArtifactAccess.ts";
import * as ThreadArchive from "./ThreadArchive.ts";
import * as ThreadArchiveAccess from "./ThreadArchiveAccess.ts";
import * as ArtifactHttp from "./artifactHttp.ts";
import * as AutomationRuntime from "../automation/Runtime.ts";

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
    const grants = yield* Config.Boolean("FOUNDRY_GATEWAY_GRANTS_ENABLED").pipe(
      Config.withDefault(false),
    );
    const gateway = yield* Config.Boolean("FOUNDRY_HTTP_GATEWAY_ENABLED").pipe(
      Config.withDefault(false),
    );
    const streams = yield* Config.Boolean("FOUNDRY_STREAM_GATEWAY_ENABLED").pipe(
      Config.withDefault(false),
    );
    const artifacts = yield* Config.Boolean("FOUNDRY_ARTIFACTS_ENABLED").pipe(
      Config.withDefault(false),
    );
    const automation = yield* Config.Boolean("FOUNDRY_AUTOMATION_ENABLED").pipe(
      Config.withDefault(false),
    );
    const sandboxes = yield* Config.Boolean("FOUNDRY_SANDBOXES_ENABLED").pipe(
      Config.withDefault(false),
    );
    if (sandboxes && !automation) return yield* new FoundryDeviceError({ code: "configuration" });
    if (automation && !artifacts) return yield* new FoundryDeviceError({ code: "configuration" });
    if (artifacts && !streams) return yield* new FoundryDeviceError({ code: "configuration" });
    if (streams && !gateway) return yield* new FoundryDeviceError({ code: "configuration" });
    if (gateway && !grants) return yield* new FoundryDeviceError({ code: "configuration" });
    if (grants && !channel) return yield* new FoundryDeviceError({ code: "configuration" });
    if (!enabled)
      return FoundryHttp.layer.pipe(
        Layer.provide(InstanceDescriptor.layer),
        Layer.provide(InstancePersistence.layer),
        Layer.provide(EnvironmentAuthPolicy.layer),
      );
    const store = yield* Config.String("FOUNDRY_INSTANCE_STORE");
    if (store !== "postgres") return yield* new AccessConfig.AccessConfigurationError({});
    const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
    const artifactRoutes = artifacts
      ? Layer.merge(
          ArtifactHttp.layer,
          AutomationRuntime.layer.pipe(
            Layer.provide(MachineCredentials.layer),
            Layer.provide(GatewayGrants.layer),
            Layer.provide(DeviceGrants.layer),
            Layer.provide(DeviceChannel.layer),
          ),
        ).pipe(
          Layer.provideMerge(
            SandboxRuntime.layer.pipe(
              Layer.provide(WorkerTransport.layer),
              Layer.provide(GatewayGrants.layer),
              Layer.provide(Git.layer.pipe(Layer.provide(VcsProcess.layer))),
            ),
          ),
          Layer.provide(Layer.merge(ArtifactAccess.layer, ThreadArchiveAccess.layer)),
          Layer.provideMerge(
            ProviderConnectionAccess.layer.pipe(
              Layer.provideMerge(
                ProviderConnections.layer.pipe(
                  Layer.provide(FetchHttpClient.layer),
                  Layer.provide(
                    ProviderConnectionAuth.layer.pipe(Layer.provide(FetchHttpClient.layer)),
                  ),
                ),
              ),
            ),
          ),
          Layer.provide(DeviceGrants.layer),
          Layer.provide(SandboxGatewayAccess.layer),
          Layer.provide(DeviceChannel.layer),
          Layer.provide(ThreadArchive.layer),
          Layer.provide(Artifacts.layer),
          Layer.provide(
            ArtifactFiles.layer.pipe(
              Layer.provide(
                Layer.effect(
                  ArtifactFiles.ArtifactDirectory,
                  Effect.gen(function* () {
                    const config = yield* ServerConfig.ServerConfig;
                    const fs = yield* FileSystem.FileSystem;
                    const path = yield* Path.Path;
                    return {
                      path: path.join(yield* fs.realPath(config.stateDir), "foundry-artifacts"),
                    };
                  }),
                ),
              ),
            ),
          ),
        )
      : Layer.empty;
    const deviceRoutes = enrollment
      ? Layer.merge(
          DeviceHttp.layer,
          channel
            ? Layer.merge(
                DeviceChannelHttp.layer,
                grants
                  ? GatewayHttp.layer.pipe(
                      Layer.provide(
                        GatewayGrants.layer.pipe(
                          Layer.provide(DeviceGrants.layer),
                          Layer.provide(SandboxGatewayAccess.layer),
                        ),
                      ),
                    )
                  : Layer.empty,
              ).pipe(Layer.provide(DeviceChannel.layer))
            : Layer.empty,
        ).pipe(Layer.provide(DeviceRegistry.layer), Layer.provide(DeviceConfig.layer))
      : Layer.empty;
    return Layer.mergeAll(
      FoundryHttp.layer,
      AuthHttp.layer,
      deviceRoutes,
      artifactRoutes.pipe(Layer.provide(DeviceRegistry.layer), Layer.provide(DeviceConfig.layer)),
    ).pipe(
      Layer.provide(Layer.merge(InstanceDescriptor.layer, FoundrySessions.layer)),
      Layer.provide(AccessVerifier.layer),
      Layer.provide(AccessVerifier.layerRemoteKeys),
      Layer.provide(AccessConfig.layer),
      Layer.provide(Layer.succeed(AccessConfig.AccessEnabled, true)),
      Layer.provide(Layer.succeed(DeviceConfig.DeviceEnrollmentEnabled, enrollment)),
      Layer.provide(Layer.succeed(DeviceConfig.DeviceChannelEnabled, channel)),
      Layer.provide(Layer.succeed(DeviceConfig.HttpGatewayEnabled, gateway)),
      Layer.provide(Layer.succeed(DeviceConfig.StreamGatewayEnabled, streams)),
      Layer.provide(Layer.succeed(DeviceConfig.ArtifactsEnabled, artifacts)),
      Layer.provide(InstancePostgres.layerIdentity),
      Layer.provide(InstancePostgres.layer),
      Layer.provide(InstanceDatabase.layer({ url })),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(EnvironmentAuthPolicy.layer),
    );
  }),
);
