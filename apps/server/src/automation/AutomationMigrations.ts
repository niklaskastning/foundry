import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";

export class AutomationMigrationError extends Schema.TaggedError<AutomationMigrationError>()(
  "AutomationMigrationError",
  {
    reason: Schema.Literals(["unsafe_role", "schema_incompatible", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Automation migration failed.";
  }
}
export class AutomationMigrations extends Context.Service<
  AutomationMigrations,
  {
    readonly migrate: (runtimeRole: string) => Effect.Effect<void, AutomationMigrationError>;
  }
>()("t3/automation/AutomationMigrations") {}
const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const migrate = Effect.fn("AutomationMigrations.migrate")(
    function* (runtimeRole: string) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(1179602514, 18)`;
          const roles = yield* sql<{
            safe: boolean;
          }>`SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
        AND NOT pg_has_role(oid, current_user, 'MEMBER')
        AND NOT has_database_privilege(oid, current_database(), 'CREATE')
        AND NOT has_database_privilege(oid, current_database(), 'TEMP')
        AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE
          (elevated.rolsuper OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolreplication OR elevated.rolbypassrls)
          AND pg_has_role(r.oid, elevated.oid, 'MEMBER'))
        AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_'
          AND (has_schema_privilege(r.oid, n.oid, 'CREATE') OR pg_has_role(r.oid, n.nspowner, 'MEMBER')))
        AS safe FROM pg_roles r WHERE rolname=${runtimeRole}`;
          if (roles[0]?.safe !== true)
            return yield* new AutomationMigrationError({ reason: "unsafe_role" });
          const existing =
            yield* sql`SELECT 1 FROM pg_namespace WHERE nspname='foundry_automation'`;
          if (existing.length === 0) {
            yield* sql`CREATE SCHEMA foundry_automation`;
            yield* sql`CREATE TABLE foundry_automation.schema_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.factories (id text PRIMARY KEY, name text NOT NULL, archived boolean NOT NULL DEFAULT false)`;
            yield* sql`CREATE TABLE foundry_automation.versions (id text PRIMARY KEY, factory_id text NOT NULL REFERENCES foundry_automation.factories(id), repositories text[] NOT NULL CHECK(cardinality(repositories)>0), UNIQUE(factory_id,id))`;
            yield* sql`CREATE TABLE foundry_automation.work_items (id text PRIMARY KEY, factory_id text NOT NULL, version_id text NOT NULL, repository text NOT NULL, title text NOT NULL, source jsonb NOT NULL, state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','in_progress','review','completed','cancelled')), FOREIGN KEY(factory_id,version_id) REFERENCES foundry_automation.versions(factory_id,id))`;
            yield* sql`CREATE TABLE foundry_automation.commands (id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL)`;
            yield* sql`INSERT INTO foundry_automation.schema_version(version) VALUES(1)`;
          }
          const versions = yield* sql<{
            version: number;
          }>`SELECT version FROM foundry_automation.schema_version`;
          if (versions.length !== 1 || ![1, 2, 3].includes(versions[0]?.version ?? 0))
            return yield* new AutomationMigrationError({ reason: "schema_incompatible" });
          if (versions[0]?.version === 1) {
            yield* sql`ALTER TABLE foundry_automation.work_items ADD CONSTRAINT work_items_factory_id_id_key UNIQUE(factory_id,id)`;
            yield* sql`CREATE TABLE foundry_automation.workflow_versions (id text PRIMARY KEY, factory_id text NOT NULL, factory_version_id text NOT NULL, steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps)>0), FOREIGN KEY(factory_id,factory_version_id) REFERENCES foundry_automation.versions(factory_id,id), UNIQUE(factory_id,id,factory_version_id))`;
            yield* sql`CREATE TABLE foundry_automation.runs (id text PRIMARY KEY, factory_id text NOT NULL, work_item_id text NOT NULL, workflow_version_id text NOT NULL, factory_version_id text NOT NULL, repository text NOT NULL, revision text NOT NULL, state text NOT NULL CHECK(state='pending'), FOREIGN KEY(factory_id,work_item_id) REFERENCES foundry_automation.work_items(factory_id,id), FOREIGN KEY(factory_id,workflow_version_id,factory_version_id) REFERENCES foundry_automation.workflow_versions(factory_id,id,factory_version_id))`;
            yield* sql`CREATE TABLE foundry_automation.outbox (id text PRIMARY KEY REFERENCES foundry_automation.commands(id), run_id text NOT NULL UNIQUE REFERENCES foundry_automation.runs(id), kind text NOT NULL CHECK(kind='run.created'), payload jsonb NOT NULL)`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=2`;
          }
          if ([1, 2].includes(versions[0]?.version ?? 0)) {
            yield* sql`CREATE TABLE foundry_automation.definition_versions (id text PRIMARY KEY, command_id text NOT NULL UNIQUE REFERENCES foundry_automation.commands(id), factory_id text NOT NULL, factory_version_id text NOT NULL, scope_version_id text NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), source jsonb NOT NULL, definition jsonb NOT NULL, workflow_versions jsonb NOT NULL, FOREIGN KEY(factory_id,factory_version_id) REFERENCES foundry_automation.versions(factory_id,id), FOREIGN KEY(factory_id,scope_version_id) REFERENCES foundry_automation.versions(factory_id,id), UNIQUE(factory_id,id))`;
            yield* sql`CREATE TABLE foundry_automation.definition_heads (factory_id text PRIMARY KEY REFERENCES foundry_automation.factories(id), version_id text NOT NULL, FOREIGN KEY(factory_id,version_id) REFERENCES foundry_automation.definition_versions(factory_id,id))`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=3`;
          }
          yield* sql`GRANT USAGE ON SCHEMA foundry_automation TO ${sql(runtimeRole)}`;
          yield* sql`GRANT SELECT ON ALL TABLES IN SCHEMA foundry_automation TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.factories, foundry_automation.versions, foundry_automation.work_items, foundry_automation.commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.workflow_versions, foundry_automation.runs, foundry_automation.outbox TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.definition_versions, foundry_automation.definition_heads TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(version_id) ON foundry_automation.definition_heads TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(archived) ON foundry_automation.factories TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state) ON foundry_automation.work_items TO ${sql(runtimeRole)}`;
        }),
      );
    },
    Effect.mapError((cause) => new AutomationMigrationError({ reason: "unavailable", cause })),
  );
  return AutomationMigrations.of({ migrate });
});
export const layer = Layer.effect(AutomationMigrations, make);
