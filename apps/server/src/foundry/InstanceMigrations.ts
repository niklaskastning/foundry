import type { EnvironmentId, FoundryInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as InstanceDatabase from "./InstanceDatabase.ts";

export class InstanceMigrations extends Context.Service<
  InstanceMigrations,
  {
    readonly migrate: (input: {
      readonly instanceId: FoundryInstanceId;
      readonly mainEnvironmentId: EnvironmentId;
      readonly runtimeRole: string;
    }) => Effect.Effect<void, InstanceDatabase.InstanceDatabaseError>;
  }
>()("t3/foundry/InstanceMigrations") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const migrate = Effect.fn("InstanceMigrations.migrate")(
    function* (input: Parameters<InstanceMigrations["Service"]["migrate"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
          // The transaction lock serializes the empty-database check with schema publication.
          yield* sql`SELECT pg_advisory_xact_lock(1179602514, 1)`;
          yield* InstanceDatabase.checkRuntimeRole(input.runtimeRole);
          const roles = yield* sql<{
            same: boolean;
          }>`SELECT pg_has_role(${input.runtimeRole}, current_user, 'MEMBER') AS same`;
          if (roles[0]?.same)
            return yield* new InstanceDatabase.InstanceDatabaseError({ reason: "unsafe_role" });
          const schemas = yield* sql<{ nspname: string }>`SELECT nspname FROM pg_namespace
        WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND nspname <> 'public'`;
          if (schemas.some((row) => row.nspname !== "foundry_instance")) {
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "unknown_database",
            });
          }
          const publicObjects =
            yield* sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
        UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
        UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'`;
          if (publicObjects.length > 0)
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "unknown_database",
            });
          if (schemas.length === 0) {
            yield* sql`CREATE SCHEMA foundry_instance`;
            yield* sql`CREATE TABLE foundry_instance.schema_version (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL)`;
            yield* sql`CREATE TABLE foundry_instance.instance (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          instance_id uuid NOT NULL UNIQUE, main_environment_id text NOT NULL CHECK (length(main_environment_id) > 0),
          access_generation bigint NOT NULL DEFAULT 0 CHECK (access_generation >= 0))`;
            yield* sql`CREATE TABLE foundry_instance.operator_binding (
          singleton boolean PRIMARY KEY DEFAULT true REFERENCES foundry_instance.instance(singleton) CHECK (singleton),
          operator_id uuid NOT NULL UNIQUE, issuer text NOT NULL CHECK (length(issuer) > 0),
          subject text NOT NULL CHECK (length(subject) > 0),
          access_generation bigint NOT NULL DEFAULT 0 CHECK (access_generation >= 0), UNIQUE (issuer, subject))`;
            yield* sql`INSERT INTO foundry_instance.instance (instance_id, main_environment_id) VALUES (${input.instanceId}, ${input.mainEnvironmentId})`;
            yield* sql`INSERT INTO foundry_instance.schema_version (version) VALUES (1)`;
          }
          yield* InstanceDatabase.checkSchema();
          const identities = yield* sql<{
            instance_id: string;
            main_environment_id: string;
          }>`SELECT instance_id, main_environment_id FROM foundry_instance.instance`;
          if (
            identities.length !== 1 ||
            identities[0]?.instance_id !== input.instanceId ||
            identities[0]?.main_environment_id !== input.mainEnvironmentId
          ) {
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "identity_conflict",
            });
          }
          yield* sql`GRANT USAGE ON SCHEMA foundry_instance TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT ON foundry_instance.schema_version, foundry_instance.instance, foundry_instance.operator_binding TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (access_generation) ON foundry_instance.instance TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_instance.operator_binding TO ${sql(input.runtimeRole)}`;
        }),
      );
    },
    Effect.provideService(InstanceDatabase.InstanceDatabase, sql),
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(new InstanceDatabase.InstanceDatabaseError({ reason: "unavailable", cause })),
    }),
  );
  return InstanceMigrations.of({ migrate });
});
export const layer = Layer.effect(InstanceMigrations, make);
