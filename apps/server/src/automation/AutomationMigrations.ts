import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import { migrateDefinitionSources } from "./DefinitionSourceSchema.ts";
import { createEvaluationSchema } from "./EvaluationSchema.ts";

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
          if (
            versions.length !== 1 ||
            ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(versions[0]?.version ?? 0)
          )
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
          if ([1, 2, 3].includes(versions[0]?.version ?? 0)) {
            yield* sql`CREATE TABLE foundry_automation.dispatch_runs (run_id text PRIMARY KEY REFERENCES foundry_automation.runs(id), worker_id text NOT NULL, binding jsonb NOT NULL, state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','waiting','failed','succeeded')), reason text, enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
            yield* sql`CREATE INDEX dispatch_runs_ready ON foundry_automation.dispatch_runs(worker_id,enrolled_at,run_id) WHERE state IN ('running','waiting')`;
            yield* sql`CREATE TABLE foundry_automation.dispatch_workers (worker_id text PRIMARY KEY, run_id text REFERENCES foundry_automation.dispatch_runs(run_id), claim_owner text, claim_generation integer NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT '-infinity')`;
            yield* sql`CREATE TABLE foundry_automation.step_attempts (command_id text PRIMARY KEY, run_id text NOT NULL REFERENCES foundry_automation.dispatch_runs(run_id), ordinal integer NOT NULL CHECK(ordinal>=0), request jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','waiting','finalizing','failed','succeeded')), reason text, receipt jsonb, result jsonb, UNIQUE(run_id,ordinal))`;
            yield* sql`CREATE TABLE foundry_automation.dispatch_outbox (command_id text PRIMARY KEY REFERENCES foundry_automation.step_attempts(command_id), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','confirmed')))`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=4`;
          }
          if ([1, 2, 3, 4].includes(versions[0]?.version ?? 0)) {
            yield* sql`ALTER TABLE foundry_automation.dispatch_outbox DROP CONSTRAINT dispatch_outbox_state_check, ADD CONSTRAINT dispatch_outbox_state_check CHECK(state IN ('pending','sending','delivered','confirmed'))`;
            yield* sql`ALTER TABLE foundry_automation.step_attempts DROP CONSTRAINT step_attempts_run_id_ordinal_key, ADD COLUMN attempt_number integer NOT NULL DEFAULT 0, ADD COLUMN archive_cursor integer NOT NULL DEFAULT 0, ADD CONSTRAINT step_attempts_run_step_attempt_key UNIQUE(run_id,ordinal,attempt_number)`;
            yield* sql`CREATE TABLE foundry_automation.run_controls (run_id text PRIMARY KEY REFERENCES foundry_automation.dispatch_runs(run_id), revision integer NOT NULL DEFAULT 0, result_revision integer NOT NULL DEFAULT 0, mode text NOT NULL DEFAULT 'active' CHECK(mode IN ('active','paused','cancel_requested','cancelled')))`;
            yield* sql`INSERT INTO foundry_automation.run_controls(run_id) SELECT run_id FROM foundry_automation.dispatch_runs`;
            yield* sql`CREATE TABLE foundry_automation.control_commands (id text PRIMARY KEY REFERENCES foundry_automation.commands(id), receipt jsonb NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.run_decisions (command_id text PRIMARY KEY REFERENCES foundry_automation.commands(id), run_id text NOT NULL REFERENCES foundry_automation.runs(id), step_id text NOT NULL, revision integer NOT NULL, result_revision integer NOT NULL, approved boolean NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.run_questions (run_id text NOT NULL REFERENCES foundry_automation.runs(id), request_id text NOT NULL, thread_id text NOT NULL, payload jsonb NOT NULL, status text NOT NULL CHECK(status IN ('pending','answered','resolved')), answer jsonb, source_sequence bigint NOT NULL, PRIMARY KEY(run_id,request_id))`;
            yield* sql`CREATE TABLE foundry_automation.manual_admissions (run_id text PRIMARY KEY REFERENCES foundry_automation.runs(id), command_id text NOT NULL UNIQUE REFERENCES foundry_automation.commands(id), identity jsonb NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.inbox_entries (id text PRIMARY KEY, instance_id text NOT NULL, operator_id text NOT NULL, factory_id text NOT NULL REFERENCES foundry_automation.factories(id), work_item_id text NOT NULL REFERENCES foundry_automation.work_items(id), run_id text NOT NULL REFERENCES foundry_automation.runs(id), kind text NOT NULL CHECK(kind IN ('question','answer','approval','blocker','error')), source_revision text NOT NULL, source jsonb NOT NULL, active boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
            yield* sql`CREATE INDEX inbox_entries_owner ON foundry_automation.inbox_entries(instance_id,operator_id,id)`;
            yield* sql`CREATE TABLE foundry_automation.inbox_marks (operator_id text NOT NULL,item_id text NOT NULL REFERENCES foundry_automation.inbox_entries(id),source_revision text NOT NULL,is_read boolean NOT NULL DEFAULT false,is_done boolean NOT NULL DEFAULT false,PRIMARY KEY(operator_id,item_id,source_revision))`;
            yield* sql`CREATE TABLE foundry_automation.inbox_commands (id text PRIMARY KEY,operator_id text NOT NULL,payload jsonb NOT NULL,receipt jsonb NOT NULL)`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=5`;
          }
          if ((versions[0]?.version ?? 0) < 6) {
            yield* sql`CREATE TABLE foundry_automation.trigger_bindings (id text PRIMARY KEY, factory_id text NOT NULL REFERENCES foundry_automation.factories(id), generation integer NOT NULL DEFAULT 1 CHECK(generation>0), instance_id text NOT NULL, operator_id text NOT NULL, definition_version_id text NOT NULL, workflow_version_id text NOT NULL REFERENCES foundry_automation.workflow_versions(id), repository text NOT NULL, source jsonb NOT NULL, target jsonb NOT NULL, state text NOT NULL DEFAULT 'inactive' CHECK(state IN ('inactive','baselining','active','paused','revoked')), activated_at bigint, next_due_at bigint, next_poll_at bigint NOT NULL DEFAULT 0, cursor jsonb, failures integer NOT NULL DEFAULT 0, reason text, skipped_ranges integer NOT NULL DEFAULT 0, FOREIGN KEY(factory_id,definition_version_id) REFERENCES foundry_automation.definition_versions(factory_id,id))`;
            yield* sql`CREATE TABLE foundry_automation.unattended_grants (binding_id text PRIMARY KEY REFERENCES foundry_automation.trigger_bindings(id), generation integer NOT NULL CHECK(generation>0), enabled boolean NOT NULL DEFAULT true, identity jsonb NOT NULL, authorized_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
            yield* sql`CREATE TABLE foundry_automation.trigger_events (id text PRIMARY KEY, binding_id text NOT NULL REFERENCES foundry_automation.trigger_bindings(id), generation integer NOT NULL CHECK(generation>0), deduplication_key text NOT NULL, source text NOT NULL CHECK(source IN ('github_issue','schedule')), external_id text NOT NULL, revision text NOT NULL, title text NOT NULL, occurred_at bigint NOT NULL, received_at bigint NOT NULL, next_attempt_at bigint NOT NULL DEFAULT 0, payload jsonb NOT NULL, state text NOT NULL CHECK(state IN ('accepted','admitted','baseline','blocked','discarded','skipped')), reason text, run_id text UNIQUE REFERENCES foundry_automation.runs(id), UNIQUE(binding_id,generation,deduplication_key))`;
            yield* sql`CREATE INDEX trigger_events_pending ON foundry_automation.trigger_events(binding_id,received_at,id) WHERE state IN ('accepted','blocked')`;
            yield* sql`CREATE TABLE foundry_automation.trigger_admissions (run_id text PRIMARY KEY REFERENCES foundry_automation.runs(id), event_id text NOT NULL UNIQUE REFERENCES foundry_automation.trigger_events(id), binding_id text NOT NULL REFERENCES foundry_automation.trigger_bindings(id), generation integer NOT NULL, identity jsonb NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.trigger_commands (id text PRIMARY KEY, payload jsonb NOT NULL, result jsonb NOT NULL, instance_id text NOT NULL, operator_id text NOT NULL)`;
            yield* sql`CREATE TABLE foundry_automation.publish_operations (operation_key text PRIMARY KEY, run_id text NOT NULL REFERENCES foundry_automation.runs(id), step_id text NOT NULL, commit_sha text NOT NULL, result_revision integer NOT NULL, repository text NOT NULL, request jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', result jsonb, UNIQUE(run_id,step_id,result_revision))`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=6`;
          }
          if ((versions[0]?.version ?? 0) < 7) {
            yield* sql`CREATE TABLE foundry_automation.definition_sources (factory_id text PRIMARY KEY REFERENCES foundry_automation.factories(id), location jsonb NOT NULL, scope_version_id text NOT NULL, instance_id text NOT NULL, operator_id text NOT NULL, app_generation integer NOT NULL CHECK(app_generation>0), generation integer NOT NULL DEFAULT 1 CHECK(generation>0), ownership text NOT NULL DEFAULT 'pending' CHECK(ownership IN ('pending','git')), enabled boolean NOT NULL DEFAULT true, import_version_id text, import_content_hash text, selected_revision_id text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','invalid','error','paused')), error text, next_sync_at bigint NOT NULL DEFAULT 0, FOREIGN KEY(factory_id,scope_version_id) REFERENCES foundry_automation.versions(factory_id,id), FOREIGN KEY(factory_id,import_version_id) REFERENCES foundry_automation.definition_versions(factory_id,id))`;
            yield* sql`CREATE TABLE foundry_automation.definition_git_revisions (id text PRIMARY KEY, factory_id text NOT NULL REFERENCES foundry_automation.factories(id), commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'), content_hash text, valid boolean NOT NULL, issues jsonb NOT NULL, files jsonb NOT NULL, created_at bigint NOT NULL, UNIQUE(factory_id,commit_sha), UNIQUE(factory_id,id))`;
            yield* sql`ALTER TABLE foundry_automation.definition_sources ADD FOREIGN KEY(factory_id,selected_revision_id) REFERENCES foundry_automation.definition_git_revisions(factory_id,id)`;
            yield* sql`CREATE TABLE foundry_automation.definition_source_commands (id text PRIMARY KEY, payload jsonb NOT NULL, result jsonb NOT NULL, instance_id text NOT NULL, operator_id text NOT NULL)`;
            yield* sql`CREATE INDEX definition_sources_due ON foundry_automation.definition_sources(next_sync_at,factory_id) WHERE enabled`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=7`;
          }
          if ((versions[0]?.version ?? 0) < 8) {
            yield* sql`CREATE TABLE foundry_automation.work_item_handoffs (id text PRIMARY KEY, factory_id text NOT NULL, work_item_id text NOT NULL, run_id text NOT NULL UNIQUE REFERENCES foundry_automation.runs(id), source_command_id text NOT NULL REFERENCES foundry_automation.step_attempts(command_id), instance_id text NOT NULL, operator_id text NOT NULL, environment_id text NOT NULL, generation integer NOT NULL DEFAULT 0 CHECK(generation>=0), base_revision text NOT NULL, state text NOT NULL CHECK(state IN ('opening','open','returning','returned')), mode text NOT NULL CHECK(mode IN ('existing','branch','archive')), open_request jsonb NOT NULL, receipt jsonb, result jsonb, continuation_run_id text REFERENCES foundry_automation.runs(id), FOREIGN KEY(factory_id,work_item_id) REFERENCES foundry_automation.work_items(factory_id,id))`;
            yield* sql`CREATE UNIQUE INDEX work_item_handoffs_active ON foundry_automation.work_item_handoffs(work_item_id) WHERE state<>'returned'`;
            yield* sql`CREATE INDEX work_item_handoffs_thread ON foundry_automation.work_item_handoffs(environment_id,(receipt->>'threadId'))`;
            yield* sql`CREATE TABLE foundry_automation.handoff_commands (id text PRIMARY KEY, payload jsonb NOT NULL, handoff_id text NOT NULL REFERENCES foundry_automation.work_item_handoffs(id), receipt jsonb)`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=8`;
          }
          if ((versions[0]?.version ?? 0) < 9) {
            yield* sql`CREATE TABLE IF NOT EXISTS foundry_automation.execution_defaults (factory_id text NOT NULL REFERENCES foundry_automation.factories(id), repository text NOT NULL, generation integer NOT NULL CHECK(generation>0), instance_id text NOT NULL, operator_id text NOT NULL, settings jsonb NOT NULL, PRIMARY KEY(factory_id,repository))`;
            yield* sql`CREATE TABLE IF NOT EXISTS foundry_automation.execution_defaults_commands (id text PRIMARY KEY, payload jsonb NOT NULL, result jsonb NOT NULL, instance_id text NOT NULL, operator_id text NOT NULL)`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=9`;
          }
          if ((versions[0]?.version ?? 0) < 10) {
            yield* sql`ALTER TABLE foundry_automation.workflow_versions ADD COLUMN execution jsonb`;
            yield* sql`ALTER TABLE foundry_automation.step_attempts ADD COLUMN worker_id text, ADD COLUMN worker_binding jsonb, ADD COLUMN capacity_released boolean NOT NULL DEFAULT false`;
            yield* sql`CREATE TABLE foundry_automation.dispatch_capacity (worker_id text PRIMARY KEY, capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 8), paused boolean NOT NULL DEFAULT false)`;
            yield* sql`CREATE INDEX step_attempts_capacity ON foundry_automation.step_attempts(worker_id) WHERE NOT capacity_released`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=10`;
          }
          if ((versions[0]?.version ?? 0) < 11) {
            yield* sql`ALTER TABLE foundry_automation.workflow_versions ADD COLUMN IF NOT EXISTS v4 jsonb, DROP CONSTRAINT workflow_versions_steps_check, ADD CONSTRAINT workflow_versions_steps_check CHECK(jsonb_typeof(steps)='array' AND (jsonb_array_length(steps)>0 OR v4 IS NOT NULL))`;
            yield* sql`ALTER TABLE foundry_automation.dispatch_runs ADD COLUMN IF NOT EXISTS v4_state jsonb`;
            yield* sql`ALTER TABLE foundry_automation.runs ADD COLUMN IF NOT EXISTS inputs jsonb`;
            yield* sql`CREATE TABLE IF NOT EXISTS foundry_automation.mcp_bindings(factory_id text NOT NULL REFERENCES foundry_automation.factories(id),resource_id text NOT NULL,generation integer NOT NULL CHECK(generation>0),binding jsonb NOT NULL,PRIMARY KEY(factory_id,resource_id))`;
            yield* sql`UPDATE foundry_automation.schema_version SET version=11`;
          }
          if ((versions[0]?.version ?? 0) < 12) {
            yield* migrateDefinitionSources.pipe(
              Effect.provideService(AutomationDatabase.AutomationDatabase, sql),
            );
            yield* createEvaluationSchema(runtimeRole).pipe(
              Effect.provideService(AutomationDatabase.AutomationDatabase, sql),
            );
            yield* sql`UPDATE foundry_automation.schema_version SET version=12`;
          }
          yield* sql`GRANT SELECT, INSERT ON foundry_automation.evaluation_queue, foundry_automation.evaluation_results TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state,claim_token,claimed_at) ON foundry_automation.evaluation_queue TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.mcp_bindings TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(v4_state) ON foundry_automation.dispatch_runs TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.dispatch_capacity TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(capacity_released) ON foundry_automation.step_attempts TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.execution_defaults TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.execution_defaults_commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.work_item_handoffs, foundry_automation.handoff_commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.definition_sources TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.definition_git_revisions, foundry_automation.definition_source_commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT SELECT, INSERT, UPDATE ON foundry_automation.trigger_bindings, foundry_automation.unattended_grants, foundry_automation.trigger_events, foundry_automation.trigger_admissions, foundry_automation.trigger_commands, foundry_automation.publish_operations TO ${sql(runtimeRole)}`;
          yield* sql`GRANT USAGE ON SCHEMA foundry_automation TO ${sql(runtimeRole)}`;
          yield* sql`GRANT SELECT ON ALL TABLES IN SCHEMA foundry_automation TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.factories, foundry_automation.versions, foundry_automation.work_items, foundry_automation.commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.workflow_versions, foundry_automation.runs, foundry_automation.outbox TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.definition_versions, foundry_automation.definition_heads TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(version_id) ON foundry_automation.definition_heads TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(archived) ON foundry_automation.factories TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state) ON foundry_automation.work_items TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.dispatch_runs, foundry_automation.dispatch_workers, foundry_automation.step_attempts, foundry_automation.dispatch_outbox TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state,reason) ON foundry_automation.dispatch_runs TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(run_id,claim_owner,claim_generation,lease_until) ON foundry_automation.dispatch_workers TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state,reason,receipt,result,archive_cursor) ON foundry_automation.step_attempts TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT, UPDATE ON foundry_automation.run_controls, foundry_automation.run_questions, foundry_automation.inbox_entries, foundry_automation.inbox_marks TO ${sql(runtimeRole)}`;
          yield* sql`GRANT INSERT ON foundry_automation.control_commands, foundry_automation.run_decisions, foundry_automation.manual_admissions, foundry_automation.inbox_commands TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(binding) ON foundry_automation.dispatch_runs TO ${sql(runtimeRole)}`;
          yield* sql`GRANT UPDATE(state) ON foundry_automation.dispatch_outbox TO ${sql(runtimeRole)}`;
        }),
      );
    },
    Effect.mapError((cause) => new AutomationMigrationError({ reason: "unavailable", cause })),
  );
  return AutomationMigrations.of({ migrate });
});
export const layer = Layer.effect(AutomationMigrations, make);
