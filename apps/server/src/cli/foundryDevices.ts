import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryDevicePublicKey,
  FoundryEnrollment,
  FoundryDeviceError,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { Command, Flag } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeviceConfig from "../foundry/DeviceConfig.ts";
import * as DeviceRegistry from "../foundry/DeviceRegistry.ts";
import * as InstanceDatabase from "../foundry/InstanceDatabase.ts";
import * as InstancePostgres from "../foundry/InstancePostgres.ts";
import { generateDeviceKey, signEnrollment } from "../foundry/DeviceProof.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeInvitation = Schema.decodeUnknownEffect(FoundryEnrollment);
const decodeKey = Schema.decodeUnknownEffect(Schema.Struct({ privateKey: Schema.String }));

const write = Effect.fn("foundry.device.write")(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* encodeJson(value);
  yield* fs.writeFileString(path, `${content}\n`, { mode: 0o600, flag: "wx" });
  yield* Console.log(
    "Foundry device file written; keep private keys and enrollment proofs confidential.",
  );
});
const read = Effect.fn("foundry.device.read")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if ((yield* fs.stat(path)).size > 8192n)
    return yield* new FoundryDeviceError({ code: "invalid_enrollment" });
  const content = yield* fs.readFileString(path);
  return yield* decodeJson(content).pipe(
    Effect.mapError(() => new FoundryDeviceError({ code: "invalid_enrollment" })),
  );
});
const registryLayer = (
  config: ServerConfig.ServerConfig["Service"],
  url: Redacted.Redacted<string>,
) =>
  DeviceRegistry.layer.pipe(
    Layer.provide(DeviceConfig.layer),
    Layer.provide(InstancePostgres.layer),
    Layer.provide(InstanceDatabase.layer({ url })),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layer(config)),
  );

const keygen = Command.make("device-keygen", { output: Flag.String("output") }).pipe(
  Command.withDescription("Create an Ed25519 device key file; never overwrites an existing file."),
  Command.withHandler(
    Effect.fn("foundry.deviceKeygen")(function* (flags) {
      yield* write(flags.output, yield* Effect.sync(generateDeviceKey));
    }),
  ),
);
const approve = Command.make("approve-device", {
  ...authLocationFlags,
  publicKey: Flag.String("public-key").pipe(Flag.withSchema(FoundryDevicePublicKey)),
  environmentId: Flag.String("environment-id").pipe(Flag.withSchema(EnvironmentId)),
  output: Flag.String("output"),
}).pipe(
  Command.withDescription(
    "Locally approve a confirmed device key/environment for ten minutes; writes a confidential invitation.",
  ),
  Command.withHandler(
    Effect.fn("foundry.approveDevice")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
      const invitation = yield* DeviceRegistry.DeviceRegistry.pipe(
        Effect.flatMap((registry) => registry.approve(flags)),
        Effect.provide(registryLayer(config, url)),
      );
      yield* write(flags.output, invitation);
    }),
  ),
);
const sign = Command.make("sign-enrollment", {
  invitation: Flag.String("invitation"),
  keyFile: Flag.String("key-file"),
  output: Flag.String("output"),
}).pipe(
  Command.withDescription(
    "On the device, sign the operator-confirmed invitation with its private key; writes the enrollment request.",
  ),
  Command.withHandler(
    Effect.fn("foundry.signEnrollment")(function* (flags) {
      const invitation = yield* decodeInvitation(yield* read(flags.invitation)).pipe(
        Effect.mapError(() => new FoundryDeviceError({ code: "invalid_enrollment" })),
      );
      const key = yield* decodeKey(yield* read(flags.keyFile)).pipe(
        Effect.mapError(() => new FoundryDeviceError({ code: "invalid_proof" })),
      );
      const request = yield* Effect.try({
        try: () => signEnrollment(invitation, key.privateKey),
        catch: () => new FoundryDeviceError({ code: "invalid_proof" }),
      });
      yield* write(flags.output, request);
    }),
  ),
);
const revoke = Command.make("revoke-device", {
  ...authLocationFlags,
  deviceId: Flag.String("device-id").pipe(Flag.withSchema(FoundryDeviceId)),
}).pipe(
  Command.withDescription(
    "Revoke a registered device permanently; repeat calls do not advance its generation again.",
  ),
  Command.withHandler(
    Effect.fn("foundry.revokeDevice")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
      yield* DeviceRegistry.DeviceRegistry.pipe(
        Effect.flatMap((registry) => registry.revoke(flags.deviceId)),
        Effect.provide(registryLayer(config, url)),
      );
      yield* Console.log("Foundry device registration revoked.");
    }),
  ),
);
export const deviceCommands = [keygen, approve, sign, revoke] as const;
