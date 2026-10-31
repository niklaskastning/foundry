import { FoundryInstanceId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstanceIdentityStore from "./InstanceIdentityStore.ts";

const decodeId = Schema.decodeUnknownEffect(FoundryInstanceId);
export class InstancePostgres extends Context.Service<
  InstancePostgres,
  {
    readonly readIdentity: Effect.Effect<FoundryInstanceId, InstanceDatabase.InstanceDatabaseError>;
  }
>()("t3/foundry/InstancePostgres") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const identityPath = path.join(config.stateDir, "foundry-instance-id");
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const readIdentity = Effect.fn("InstancePostgres.readIdentity")(
    function* () {
      const localId = (yield* fs.exists(identityPath))
        ? (yield* fs.readFileString(identityPath)).trim()
        : undefined;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const roles = yield* sql<{ name: string }>`SELECT current_user AS name`;
          yield* InstanceDatabase.checkRuntimeRole(roles[0]?.name ?? "");
          yield* InstanceDatabase.checkSchema();
          const rows = yield* sql<{
            instance_id: string;
            main_environment_id: string;
          }>`SELECT instance_id, main_environment_id FROM foundry_instance.instance`;
          if (rows.length !== 1 || rows[0]?.main_environment_id !== environmentId) {
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "identity_conflict",
            });
          }
          if (localId !== undefined && localId !== rows[0].instance_id) {
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "identity_conflict",
            });
          }
          return yield* decodeId(rows[0].instance_id).pipe(
            Effect.mapError(
              (cause) =>
                new InstanceDatabase.InstanceDatabaseError({ reason: "identity_conflict", cause }),
            ),
          );
        }),
      );
    },
    Effect.provideService(InstanceDatabase.InstanceDatabase, sql),
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(
          new InstanceDatabase.InstanceDatabaseError({ reason: "identity_conflict", cause }),
        ),
      SqlError: (cause) =>
        Effect.fail(new InstanceDatabase.InstanceDatabaseError({ reason: "unavailable", cause })),
    }),
  );
  return InstancePostgres.of({ readIdentity: readIdentity() });
});
export const layer = Layer.effect(InstancePostgres, make);
export const layerIdentity = Layer.effect(
  InstanceIdentityStore.InstanceIdentityStore,
  Effect.gen(function* () {
    const postgres = yield* InstancePostgres;
    return InstanceIdentityStore.InstanceIdentityStore.of({
      getOrCreate: postgres.readIdentity.pipe(
        Effect.mapError((cause) => new InstanceIdentityStore.InstanceIdentityError({ cause })),
      ),
    });
  }),
);
