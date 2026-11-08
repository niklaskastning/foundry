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
          const versions = yield* sql<{
            version: number;
          }>`SELECT version FROM foundry_instance.schema_version`;
          if (
            versions.length !== 1 ||
            ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(versions[0]?.version ?? 0)
          ) {
            return yield* new InstanceDatabase.InstanceDatabaseError({
              reason: "schema_incompatible",
            });
          }
          if (versions[0]?.version === 1) {
            yield* sql`CREATE TABLE foundry_instance.sessions (
              token_hash text PRIMARY KEY,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              instance_generation bigint NOT NULL CHECK (instance_generation >= 0),
              operator_generation bigint NOT NULL CHECK (operator_generation >= 0),
              audience text NOT NULL, expires_at bigint NOT NULL CHECK (expires_at > 0))`;
            yield* sql`CREATE INDEX sessions_expiry ON foundry_instance.sessions(expires_at)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version = 2`;
          }
          if ((versions[0]?.version ?? 0) < 3) {
            yield* sql`CREATE TABLE foundry_instance.devices (
              device_id uuid PRIMARY KEY,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              environment_id text NOT NULL UNIQUE CHECK (length(environment_id) > 0),
              public_key text NOT NULL UNIQUE CHECK (length(public_key) = 43),
              generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
              revoked boolean NOT NULL DEFAULT false)`;
            yield* sql`CREATE TABLE foundry_instance.device_enrollments (
              token_hash text PRIMARY KEY,
              device_id uuid NOT NULL UNIQUE,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              origin text NOT NULL,
              environment_id text NOT NULL CHECK (length(environment_id) > 0),
              public_key text NOT NULL CHECK (length(public_key) = 43),
              expires_at bigint NOT NULL CHECK (expires_at > 0),
              consumed boolean NOT NULL DEFAULT false)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version = 3`;
          }
          if ((versions[0]?.version ?? 0) < 4) {
            yield* sql`ALTER TABLE foundry_instance.devices ADD COLUMN channel_generation integer NOT NULL DEFAULT 0 CHECK (channel_generation >= 0)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version = 4`;
          }
          if ((versions[0]?.version ?? 0) < 5) {
            yield* sql`CREATE TABLE foundry_instance.device_grants (
              device_id uuid NOT NULL REFERENCES foundry_instance.devices(device_id),
              kind text NOT NULL CHECK (kind IN ('clientAccess', 'automationExecution', 'sandboxProvisioning')),
              enabled boolean NOT NULL DEFAULT false,
              generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
              PRIMARY KEY (device_id, kind))`;
            yield* sql`INSERT INTO foundry_instance.device_grants (device_id, kind, enabled)
              SELECT device_id, kind, kind = 'clientAccess' AND NOT revoked FROM foundry_instance.devices
              CROSS JOIN (VALUES ('clientAccess'), ('automationExecution'), ('sandboxProvisioning')) AS kinds(kind)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version = 5`;
          }
          if ((versions[0]?.version ?? 0) < 6) {
            yield* sql`CREATE TABLE foundry_instance.artifact_uploads (
              artifact_id uuid PRIMARY KEY,
              ordinal bigserial NOT NULL UNIQUE,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              command_id text NOT NULL,
              request jsonb NOT NULL,
              state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','published','aborted')),
              confirmed_offset integer NOT NULL DEFAULT 0 CHECK(confirmed_offset >= 0 AND confirmed_offset <= (request->>'sizeBytes')::integer),
              UNIQUE(instance_id,operator_id,command_id))`;
            yield* sql`CREATE INDEX artifact_uploads_owner_page ON foundry_instance.artifact_uploads(instance_id,operator_id,ordinal DESC) WHERE state='published'`;
            yield* sql`UPDATE foundry_instance.schema_version SET version=6`;
          }
          if ((versions[0]?.version ?? 0) < 7) {
            yield* sql`CREATE TABLE foundry_instance.archive_threads (
              ordinal bigserial NOT NULL UNIQUE,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              environment_id text NOT NULL,
              thread_id text NOT NULL,
              device_id uuid NOT NULL,
              confirmed_cursor bigint NOT NULL DEFAULT 0 CHECK(confirmed_cursor >= 0),
              confirmed_source_sequence bigint NOT NULL DEFAULT 0 CHECK(confirmed_source_sequence >= 0),
              source_head bigint NOT NULL DEFAULT 0 CHECK(source_head >= confirmed_cursor),
              source_complete boolean NOT NULL,
              PRIMARY KEY(instance_id,environment_id,thread_id))`;
            yield* sql`CREATE INDEX archive_threads_owner_page ON foundry_instance.archive_threads(instance_id,operator_id,ordinal DESC)`;
            yield* sql`CREATE TABLE foundry_instance.archive_events (
              instance_id uuid NOT NULL,
              environment_id text NOT NULL,
              thread_id text NOT NULL,
              sequence bigint NOT NULL CHECK(sequence > 0),
              source_sequence bigint NOT NULL CHECK(source_sequence > 0),
              event jsonb NOT NULL,
              PRIMARY KEY(instance_id,environment_id,thread_id,sequence),
              UNIQUE(instance_id,environment_id,thread_id,source_sequence),
              FOREIGN KEY(instance_id,environment_id,thread_id)
                REFERENCES foundry_instance.archive_threads(instance_id,environment_id,thread_id))`;
            yield* sql`CREATE UNIQUE INDEX archive_event_identity ON foundry_instance.archive_events(instance_id,environment_id,thread_id,((event->'event'->>'id')))`;
            yield* sql`CREATE TABLE foundry_instance.archive_artifacts (
              instance_id uuid NOT NULL,
              environment_id text NOT NULL,
              thread_id text NOT NULL,
              attachment_id text NOT NULL,
              reference jsonb,
              PRIMARY KEY(instance_id,environment_id,thread_id,attachment_id),
              FOREIGN KEY(instance_id,environment_id,thread_id)
                REFERENCES foundry_instance.archive_threads(instance_id,environment_id,thread_id))`;
            yield* sql`UPDATE foundry_instance.schema_version SET version=7`;
          }
          if ((versions[0]?.version ?? 0) < 8) {
            yield* sql`CREATE TABLE foundry_instance.machine_credentials (
              id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              instance_generation bigint NOT NULL CHECK(instance_generation >= 0),
              operator_generation bigint NOT NULL CHECK(operator_generation >= 0),
              label text NOT NULL CHECK(length(label) BETWEEN 1 AND 100),
              factory_ids jsonb NOT NULL CHECK(jsonb_typeof(factory_ids)='array' AND jsonb_array_length(factory_ids) BETWEEN 1 AND 32),
              expires_at bigint NOT NULL CHECK(expires_at > 0),
              revoked boolean NOT NULL DEFAULT false)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version=8`;
          }
          if ((versions[0]?.version ?? 0) < 9) {
            yield* sql`CREATE TABLE foundry_instance.sandbox_profiles (
              profile_id text NOT NULL, revision uuid NOT NULL,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              profile jsonb NOT NULL, PRIMARY KEY(instance_id, profile_id, revision))`;
            yield* sql`CREATE TABLE foundry_instance.sandbox_allocations (
              allocation_id uuid PRIMARY KEY,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              command_id text NOT NULL, allocation jsonb NOT NULL,
              archive_receipt jsonb, setup_log text NOT NULL DEFAULT '', claim_owner uuid, claim_until bigint NOT NULL DEFAULT 0,
              UNIQUE(instance_id,operator_id,command_id))`;
            yield* sql`CREATE INDEX sandbox_allocations_active ON foundry_instance.sandbox_allocations(instance_id)
              WHERE allocation->>'state' <> 'deleted'`;
            yield* sql`CREATE TABLE foundry_instance.provider_connections (
              id text PRIMARY KEY,
              instance_id uuid NOT NULL REFERENCES foundry_instance.instance(instance_id),
              operator_id uuid NOT NULL REFERENCES foundry_instance.operator_binding(operator_id),
              generation integer NOT NULL CHECK(generation > 0), connection jsonb NOT NULL,
              revoked boolean NOT NULL DEFAULT false, last_issued_expires_at bigint NOT NULL DEFAULT 0)`;
            yield* sql`UPDATE foundry_instance.schema_version SET version=9`;
          }
          if ((versions[0]?.version ?? 0) < 10) {
            yield* sql`ALTER TABLE foundry_instance.machine_credentials ADD COLUMN scope text NOT NULL DEFAULT 'automation:read' CHECK (scope IN ('automation:read','automation:start','automation:control'))`;
            yield* sql`UPDATE foundry_instance.schema_version SET version=10`;
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
          yield* sql`GRANT SELECT, INSERT ON foundry_instance.sandbox_profiles TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT, UPDATE ON foundry_instance.sandbox_allocations, foundry_instance.provider_connections TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT USAGE ON SCHEMA foundry_instance TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT ON foundry_instance.schema_version, foundry_instance.instance, foundry_instance.operator_binding TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (access_generation) ON foundry_instance.instance TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT ON foundry_instance.machine_credentials TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE(revoked) ON foundry_instance.machine_credentials TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT, DELETE ON foundry_instance.sessions TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_instance.operator_binding TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT ON foundry_instance.devices, foundry_instance.device_enrollments TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (generation, revoked) ON foundry_instance.devices TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (channel_generation) ON foundry_instance.devices TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT ON foundry_instance.device_grants TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (enabled, generation) ON foundry_instance.device_grants TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE (consumed) ON foundry_instance.device_enrollments TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT ON foundry_instance.artifact_uploads TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE(confirmed_offset,state) ON foundry_instance.artifact_uploads TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT USAGE ON SEQUENCE foundry_instance.artifact_uploads_ordinal_seq TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT SELECT,INSERT ON foundry_instance.archive_threads,foundry_instance.archive_events,foundry_instance.archive_artifacts TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE(confirmed_cursor,confirmed_source_sequence,source_head) ON foundry_instance.archive_threads TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT UPDATE(reference) ON foundry_instance.archive_artifacts TO ${sql(input.runtimeRole)}`;
          yield* sql`GRANT USAGE ON SEQUENCE foundry_instance.archive_threads_ordinal_seq TO ${sql(input.runtimeRole)}`;
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
