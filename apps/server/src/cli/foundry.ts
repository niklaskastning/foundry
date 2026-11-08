import * as NativeOperator from "../foundry/NativeOperator.ts";
import * as AccessConfig from "../foundry/AccessConfig.ts";
import * as FileSystem from "effect/FileSystem";
import { sandboxSupervisorCommand } from "./foundrySandboxSupervisor.ts";
import { sandboxSkillsCommand } from "./foundrySandboxSkills.ts";
import { sandboxArchiveCommand } from "./foundrySandboxArchive.ts";
import * as InstanceOperator from "../foundry/InstanceOperator.ts";
import * as InstancePostgres from "../foundry/InstancePostgres.ts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { Command, Flag } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as InstanceDatabase from "../foundry/InstanceDatabase.ts";
import * as InstanceMigrations from "../foundry/InstanceMigrations.ts";
import * as InstanceIdentityStore from "../foundry/InstanceIdentityStore.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { deviceCommands } from "./foundryDevices.ts";
import { connectDeviceCommand } from "./foundryConnectDevice.ts";
import * as AutomationDatabase from "../automation/AutomationDatabase.ts";
import * as AutomationMigrations from "../automation/AutomationMigrations.ts";

const migrateAutomation = Command.make("automation-migrate", {
  runtimeRole: Flag.String("runtime-role"),
  database: Flag.String("database"),
}).pipe(
  Command.withDescription(
    "Migrate the explicitly selected, separate Automation database without starting runs.",
  ),
  Command.withHandler(
    Effect.fn("foundry.automationMigrate")(function* (flags) {
      const url = yield* Config.Redacted("FOUNDRY_AUTOMATION_MIGRATION_URL");
      yield* Effect.gen(function* () {
        const sql = yield* AutomationDatabase.AutomationDatabase;
        const target = yield* sql<{
          database: string;
          separate: boolean;
        }>`SELECT current_database() AS database, NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='foundry_instance') AS separate`;
        if (target[0]?.database !== flags.database || !target[0].separate)
          return yield* new AutomationMigrations.AutomationMigrationError({
            reason: "schema_incompatible",
          });
        const migrations = yield* AutomationMigrations.AutomationMigrations;
        yield* migrations.migrate(flags.runtimeRole);
      }).pipe(
        Effect.provide(
          AutomationMigrations.layer.pipe(
            Layer.provideMerge(AutomationDatabase.layer({ url, maxConnections: 1 })),
          ),
        ),
      );
      yield* Console.log("Automation schema 5 ready; no runs enrolled or started.");
    }),
  ),
);

const migrate = Command.make("migrate", {
  ...authLocationFlags,
  runtimeRole: Flag.String("runtime-role"),
}).pipe(
  Command.withDescription(
    "Migrate the separate Foundry instance database, preserving this home's identity.",
  ),
  Command.withHandler(
    Effect.fn("foundry.migrate")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const url = yield* Config.Redacted("FOUNDRY_INSTANCE_MIGRATION_URL");
      yield* Effect.gen(function* () {
        const identity = yield* InstanceIdentityStore.InstanceIdentityStore;
        const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const migrations = yield* InstanceMigrations.InstanceMigrations;
        yield* migrations.migrate({
          instanceId: yield* identity.getOrCreate,
          mainEnvironmentId: yield* environment.getEnvironmentId,
          runtimeRole: flags.runtimeRole,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InstanceIdentityStore.layerFile,
            ServerEnvironment.layerIdentity,
            InstanceMigrations.layer.pipe(
              Layer.provide(InstanceDatabase.layer({ url, maxConnections: 1 })),
            ),
          ).pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
      yield* Console.log("Foundry instance schema 11 ready; existing instance identity preserved.");
    }),
  ),
);

const bindOperator = Command.make("bind-operator", {
  ...authLocationFlags,
  issuer: Flag.String("issuer"),
  subject: Flag.String("subject"),
}).pipe(
  Command.withDescription(
    "Bind the single Foundry operator locally; conflicting bindings are rejected.",
  ),
  Command.withHandler(
    Effect.fn("foundry.bindOperator")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
      yield* InstanceOperator.InstanceOperator.pipe(
        Effect.flatMap((operator) => operator.bind(flags.issuer, flags.subject)),
        Effect.provide(
          InstanceOperator.layer.pipe(
            Layer.provide(InstancePostgres.layer),
            Layer.provide(InstanceDatabase.layer({ url })),
            Layer.provide(ServerEnvironment.layerIdentity),
            Layer.provide(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log("Foundry operator binding confirmed.");
    }),
  ),
);

const bootstrapNative = Command.make("bootstrap-native", {
  ...authLocationFlags,
  username: Flag.String("username"),
  passwordFile: Flag.String("password-file"),
}).pipe(
  Command.withDescription(
    "Create the single native Foundry operator from a local password file; existing accounts are never replaced.",
  ),
  Command.withHandler(
    Effect.fn("foundry.bootstrapNative")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const url = yield* Config.Redacted("FOUNDRY_INSTANCE_DATABASE_URL");
      const fs = yield* FileSystem.FileSystem;
      const password = (yield* fs.readFileString(flags.passwordFile)).replace(/\r?\n$/, "");
      yield* NativeOperator.NativeOperator.pipe(
        Effect.flatMap((operator) => operator.bootstrap(flags.username, password)),
        Effect.provide(
          NativeOperator.layer.pipe(
            Layer.provide(AccessConfig.layer),
            Layer.provide(InstancePostgres.layer),
            Layer.provide(InstanceDatabase.layer({ url })),
            Layer.provide(ServerEnvironment.layerIdentity),
            Layer.provide(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log("Native Foundry operator created.");
    }),
  ),
);

export const foundryCommand = Command.make("foundry").pipe(
  Command.withSubcommands([
    sandboxArchiveCommand,
    sandboxSupervisorCommand,
    sandboxSkillsCommand,
    bootstrapNative,
    migrate,
    migrateAutomation,
    bindOperator,
    ...deviceCommands,
    connectDeviceCommand,
  ]),
);
