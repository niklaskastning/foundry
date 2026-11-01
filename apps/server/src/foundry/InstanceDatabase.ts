import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class InstanceDatabaseError extends Schema.TaggedError<InstanceDatabaseError>()(
  "InstanceDatabaseError",
  {
    reason: Schema.Literals([
      "schema_incompatible",
      "unknown_database",
      "identity_conflict",
      "unsafe_role",
      "unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Foundry instance database is not ready (${this.reason}). Check the separate instance migration and database configuration.`;
  }
}

export class InstanceDatabase extends Context.Service<InstanceDatabase, PgClient.PgClient>()(
  "t3/foundry/InstanceDatabase",
) {}

export const layer = (config: PgClient.PgPoolConfig) =>
  Layer.effect(InstanceDatabase, PgClient.PgClient).pipe(
    Layer.provide(
      PgClient.layer({
        maxConnections: 4,
        minConnections: 0,
        connectTimeout: "2 seconds",
        applicationName: "foundry-instance",
        startupParameters: {
          statement_timeout: "5000",
          idle_in_transaction_session_timeout: "15000",
        },
        ...config,
      }),
    ),
  );

export const checkSchema = Effect.fn("InstanceDatabase.checkSchema")(function* () {
  const sql = yield* InstanceDatabase;
  const rows = yield* sql<{ version: number }>`SELECT version FROM foundry_instance.schema_version`;
  if (rows.length !== 1 || rows[0]?.version !== 3) {
    return yield* new InstanceDatabaseError({ reason: "schema_incompatible" });
  }
});

export const checkRuntimeRole = Effect.fn("InstanceDatabase.checkRuntimeRole")(function* (
  role: string,
) {
  const sql = yield* InstanceDatabase;
  const rows = yield* sql<{ safe: boolean }>`SELECT
    NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE
      (elevated.rolsuper OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolreplication OR elevated.rolbypassrls)
      AND pg_has_role(r.oid, elevated.oid, 'MEMBER'))
    AND NOT has_database_privilege(oid, current_database(), 'CREATE')
    AND NOT has_database_privilege(oid, current_database(), 'TEMP')
    AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_'
      AND (has_schema_privilege(r.oid, n.oid, 'CREATE') OR pg_has_role(r.oid, n.nspowner, 'MEMBER')))
    AS safe FROM pg_roles r WHERE rolname = ${role}`;
  if (rows.length !== 1 || rows[0]?.safe !== true) {
    return yield* new InstanceDatabaseError({ reason: "unsafe_role" });
  }
});
