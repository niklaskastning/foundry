import {
  FoundrySandboxArchiveManifest,
  FoundrySandboxArchiveReceipt,
  FoundrySandboxArchiveError,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as SandboxSetupSnapshot from "../foundry/SandboxSetupSnapshot.ts";
import * as SandboxArchiveEnvironment from "../foundry/SandboxArchiveEnvironment.ts";
import * as SandboxArchive from "../foundry/SandboxArchive.ts";
import * as ArchivePublication from "../foundry/ArchivePublication.ts";
import * as ArtifactPublication from "../foundry/ArtifactPublication.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(FoundrySandboxArchiveManifest));
const encodeEnvironmentManifest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadIds: Schema.Array(ThreadId),
      manifests: Schema.Array(FoundrySandboxArchiveManifest),
    }),
  ),
);
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(FoundrySandboxArchiveReceipt));
const layer = (config: ServerConfig.ServerConfig["Service"]) => {
  const artifacts = ArtifactPublication.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(FetchHttpClient.layer),
  );
  const archive = ArchivePublication.layer.pipe(
    Layer.provide(EventStore.layer),
    Layer.provide(SqlitePersistence.layerConfig),
    Layer.provide(artifacts),
  );
  return SandboxArchive.layer.pipe(
    Layer.provide(Layer.mergeAll(artifacts, archive, Git.layer)),
    Layer.provide(ServerConfig.layer(config)),
  );
};
const capture = Command.make("capture", {
  ...authLocationFlags,
  allocationId: Flag.String("allocation-id"),
  fence: Flag.Int("fence"),
  threadId: Flag.String("thread-id"),
  cwd: Flag.String("cwd"),
  checkpointRef: Flag.String("checkpoint-ref"),
  output: Flag.String("output"),
}).pipe(
  Command.withHandler(
    Effect.fn("foundry.sandboxArchive.capture")(function* (flags) {
      const allocationId = yield* Config.String("FOUNDRY_SANDBOX_ALLOCATION_ID");
      if (allocationId !== flags.allocationId || Option.isNone(flags.baseDir))
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const manifest = yield* SandboxArchive.SandboxArchive.pipe(
        Effect.flatMap((service) =>
          service.capture({
            ...flags,
            threadId: ThreadId.make(flags.threadId),
            attachmentsDir: config.attachmentsDir,
          }),
        ),
        Effect.provide(layer(config)),
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(flags.output, yield* encodeManifest(manifest), { mode: 0o600 });
      yield* Console.log(
        "Sandbox archive captured; central confirmation is still required before deletion.",
      );
    }),
  ),
);
const captureEnvironment = Command.make("capture-environment", {
  ...authLocationFlags,
  allocationId: Flag.String("allocation-id"),
  fence: Flag.Int("fence"),
  cwd: Flag.String("cwd"),
  output: Flag.String("output"),
}).pipe(
  Command.withHandler(
    Effect.fn("foundry.sandboxArchive.captureEnvironment")(function* (flags) {
      const allocationId = yield* Config.String("FOUNDRY_SANDBOX_ALLOCATION_ID");
      if (allocationId !== flags.allocationId || Option.isNone(flags.baseDir))
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const manifest = yield* SandboxArchiveEnvironment.SandboxArchiveEnvironment.pipe(
        Effect.flatMap((service) =>
          service.capture({ ...flags, attachmentsDir: config.attachmentsDir }),
        ),
        Effect.provide(
          SandboxArchiveEnvironment.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(Layer.merge(layer(config), Git.layer)),
            Layer.provide(SqlitePersistence.layerConfig),
            Layer.provide(ServerConfig.layer(config)),
          ),
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(flags.output, yield* encodeEnvironmentManifest(manifest), {
        mode: 0o600,
      });
      yield* Console.log(
        "Sandbox environment archive captured; central confirmation is still required.",
      );
    }),
  ),
);
const captureSetup = Command.make("capture-setup", {
  allocationId: Flag.String("allocation-id"),
  cwd: Flag.String("cwd"),
  setupLog: Flag.String("setup-log"),
  output: Flag.String("output"),
}).pipe(
  Command.withHandler(
    Effect.fn("foundry.sandboxArchive.captureSetup")(function* (flags) {
      if ((yield* Config.String("FOUNDRY_SANDBOX_ALLOCATION_ID")) !== flags.allocationId)
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      yield* SandboxSetupSnapshot.SandboxSetupSnapshot.pipe(
        Effect.flatMap((service) => service.capture(flags)),
        Effect.provide(SandboxSetupSnapshot.layer),
      );
      yield* Console.log(
        "Setup snapshot captured; central publication and confirmation remain required.",
      );
    }),
  ),
);
const restore = Command.make("restore", {
  ...authLocationFlags,
  receipt: Flag.String("receipt"),
  bundle: Flag.String("bundle"),
  bundleIndex: Flag.String("bundle-index").pipe(Flag.optional),
  cwd: Flag.String("cwd"),
}).pipe(
  Command.withHandler(
    Effect.fn("foundry.sandboxArchive.restore")(function* (flags) {
      yield* Config.String("FOUNDRY_SANDBOX_ALLOCATION_ID");
      if (Option.isNone(flags.baseDir))
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const fs = yield* FileSystem.FileSystem;
      if ((yield* fs.stat(flags.receipt)).size > 65536n)
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const receipt = yield* decodeReceipt(yield* fs.readFileString(flags.receipt));
      yield* SandboxArchive.SandboxArchive.pipe(
        Effect.flatMap((service) =>
          service.restore({
            receipt,
            cwd: flags.cwd,
            bundlePath: flags.bundle,
            ...(Option.isSome(flags.bundleIndex)
              ? { bundleIndexPath: flags.bundleIndex.value }
              : {}),
          }),
        ),
        Effect.provide(
          SandboxArchive.layer.pipe(
            Layer.provide(Git.layer),
            Layer.provide(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(
        "Sandbox workspace restored from verified archive; source thread remains in Main.",
      );
    }),
  ),
);
export const sandboxArchiveCommand = Command.make("sandbox-archive").pipe(
  Command.withSubcommands([capture, captureEnvironment, captureSetup, restore]),
);
