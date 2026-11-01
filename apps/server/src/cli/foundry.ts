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
      yield* Console.log("Foundry instance schema 3 ready; existing instance identity preserved.");
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

export const foundryCommand = Command.make("foundry").pipe(
  Command.withSubcommands([migrate, bindOperator, ...deviceCommands]),
);
