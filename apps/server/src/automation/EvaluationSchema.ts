import * as Effect from "effect/Effect";
import * as AutomationDatabase from "./AutomationDatabase.ts";

export const createEvaluationSchema = Effect.fn("EvaluationSchema.create")(function* (runtimeRole: string) {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  yield* sql`ALTER TABLE foundry_automation.runs ADD CONSTRAINT runs_factory_id_unique UNIQUE(factory_id,id)`;
  yield* sql`CREATE TABLE foundry_automation.evaluation_queue (
    id text PRIMARY KEY, factory_id text NOT NULL REFERENCES foundry_automation.factories(id),
    run_id text NOT NULL,
    instance_id text NOT NULL, operator_id text NOT NULL,
    input jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','finished')),
    claim_token text, claimed_at timestamptz,
    automatic_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id,factory_id,run_id), FOREIGN KEY(factory_id,run_id) REFERENCES foundry_automation.runs(factory_id,id))`;
  yield* sql`CREATE TABLE foundry_automation.evaluation_results (
    id text PRIMARY KEY,
    factory_id text NOT NULL REFERENCES foundry_automation.factories(id),
    run_id text NOT NULL,
    result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(id,factory_id,run_id) REFERENCES foundry_automation.evaluation_queue(id,factory_id,run_id))`;
  yield* sql`CREATE INDEX evaluation_queue_pending ON foundry_automation.evaluation_queue(state,created_at)`;
  yield* sql`CREATE INDEX evaluation_results_factory ON foundry_automation.evaluation_results(factory_id,id)`;
  yield* sql`GRANT SELECT,INSERT ON foundry_automation.evaluation_queue,foundry_automation.evaluation_results TO ${sql(runtimeRole)}`;
  yield* sql`GRANT UPDATE(state,claim_token,claimed_at) ON foundry_automation.evaluation_queue TO ${sql(runtimeRole)}`;
});
