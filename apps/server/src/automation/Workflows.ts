import { validateFactoryFiles } from "@t3tools/shared/factoryDefinition";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Result from "effect/Result";
import {
  type AutomationWorkflowVersion,
  type AutomationRun,
  type AutomationOutboxEntry,
  CreateAutomationWorkflowVersion,
  StartAutomationRun,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as Factories from "./Factories.ts";

const decodeVersion = Schema.decodeEffect(CreateAutomationWorkflowVersion, {
  onExcessProperty: "error",
});
const decodeStart = Schema.decodeEffect(StartAutomationRun, { onExcessProperty: "error" });
const isAutomationError = Schema.is(Factories.AutomationError);
const storageError = (cause: unknown) =>
  new Factories.AutomationError({ reason: "unavailable", cause });
const operationError = (cause: unknown) => (isAutomationError(cause) ? cause : storageError(cause));

export class Workflows extends Context.Service<
  Workflows,
  {
    readonly createVersion: (
      input: typeof CreateAutomationWorkflowVersion.Type,
    ) => Effect.Effect<AutomationWorkflowVersion, Factories.AutomationError>;
    readonly readVersion: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<AutomationWorkflowVersion, Factories.AutomationError>;
    readonly start: (
      input: typeof StartAutomationRun.Type,
    ) => Effect.Effect<AutomationRun, Factories.AutomationError>;
    readonly readRun: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<AutomationRun, Factories.AutomationError>;
    readonly readOutbox: (
      factoryId: string,
      runId: string,
    ) => Effect.Effect<ReadonlyArray<AutomationOutboxEntry>, Factories.AutomationError>;
  }
>()("t3/automation/Workflows") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const factories = yield* Factories.Factories;
  const claim = Effect.fn("Workflows.claimCommand")(function* (
    commandId: string,
    kind: string,
    payload: unknown,
  ) {
    const inserted =
      yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${commandId},${kind},${sql.json(payload)}) ON CONFLICT DO NOTHING RETURNING id`;
    const rows = yield* sql<{
      same: boolean;
    }>`SELECT kind=${kind} AND payload=${sql.json(payload)}::jsonb AS same FROM foundry_automation.commands WHERE id=${commandId}`;
    if (rows[0]?.same !== true)
      return yield* new Factories.AutomationError({ reason: "command_conflict" });
    return inserted.length > 0;
  });
  const readVersion = Effect.fn("Workflows.readVersion")(function* (factoryId: string, id: string) {
    const rows = yield* sql<
      Omit<AutomationWorkflowVersion, "execution" | "v4"> & {
        execution: AutomationWorkflowVersion["execution"] | null;
        v4: AutomationWorkflowVersion["v4"] | null;
      }
    >`SELECT id,factory_id AS "factoryId",factory_version_id AS "factoryVersionId",steps,execution,v4 FROM foundry_automation.workflow_versions WHERE factory_id=${factoryId} AND id=${id}`;
    if (!rows[0]) return yield* new Factories.AutomationError({ reason: "not_found" });
    const { execution, v4, ...version } = rows[0];
    return { ...version, ...(execution ? { execution } : {}), ...(v4 ? { v4 } : {}) };
  }, Effect.mapError(operationError));
  const readRun = Effect.fn("Workflows.readRun")(function* (factoryId: string, id: string) {
    const rows = yield* sql<
      Omit<AutomationRun, "inputs"> & { inputs: AutomationRun["inputs"] | null }
    >`SELECT r.inputs,r.id,r.factory_id AS "factoryId",r.work_item_id AS "workItemId",r.workflow_version_id AS "workflowVersionId",r.factory_version_id AS "factoryVersionId",r.repository,r.revision,CASE WHEN c.mode IS NOT NULL AND c.mode<>'active' THEN c.mode ELSE COALESCE(d.state,r.state) END AS state FROM foundry_automation.runs r LEFT JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id LEFT JOIN foundry_automation.run_controls c ON c.run_id=r.id WHERE r.factory_id=${factoryId} AND r.id=${id}`;
    if (!rows[0]) return yield* new Factories.AutomationError({ reason: "not_found" });
    const { inputs, ...run } = rows[0];
    return { ...run, ...(inputs ? { inputs } : {}) };
  }, Effect.mapError(operationError));
  const createVersion = Effect.fn("Workflows.createVersion")(function* (
    raw: typeof CreateAutomationWorkflowVersion.Type,
  ) {
    const input = yield* decodeVersion(raw).pipe(
      Effect.mapError((cause) => new Factories.AutomationError({ reason: "invalid_input", cause })),
    );
    if (input.v4) {
      const parsed = validateFactoryFiles(input.v4.files);
      if (
        Result.isFailure(parsed) ||
        parsed.success.schemaVersion !== 4 ||
        input.steps.length ||
        input.execution
      )
        return yield* new Factories.AutomationError({ reason: "invalid_input" });
      const definition = parsed.success;
      const workflow = definition.workflows.find((item) => item.id === input.v4!.workflow.id);
      const expected = {
        workflow,
        agents: definition.agents,
        skills: definition.skills,
        mcp: definition.mcp,
        files: definition.files,
        ...(definition.defaults ? { defaults: definition.defaults } : {}),
      };
      if (
        definition.factoryId !== input.factoryId ||
        !workflow ||
        stableStringify(expected) !== stableStringify(input.v4)
      )
        return yield* new Factories.AutomationError({ reason: "invalid_input" });
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (yield* claim(input.commandId, "workflowVersion", input)) {
          yield* factories.readVersion(input.factoryId, input.factoryVersionId);
          yield* sql`INSERT INTO foundry_automation.workflow_versions(id,factory_id,factory_version_id,steps,execution,v4) VALUES(${input.id},${input.factoryId},${input.factoryVersionId},${sql.json(input.steps)},${input.execution ? sql.json(input.execution) : null},${input.v4 ? sql.json(input.v4) : null})`;
        }
        return yield* readVersion(input.factoryId, input.id);
      }),
    );
  }, Effect.mapError(operationError));
  const start = Effect.fn("Workflows.start")(function* (raw: typeof StartAutomationRun.Type) {
    const input = yield* decodeStart(raw).pipe(
      Effect.mapError((cause) => new Factories.AutomationError({ reason: "invalid_input", cause })),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (yield* claim(input.commandId, "workflowRun", input)) {
          yield* factories.withStartEligibility(
            input.factoryId,
            input.workItemId,
            Effect.gen(function* () {
              const work = yield* factories.readWorkItem(input.factoryId, input.workItemId);
              const workflow = yield* readVersion(input.factoryId, input.workflowVersionId);
              if (input.inputs && !workflow.v4)
                return yield* new Factories.AutomationError({ reason: "invalid_input" });
              const version = yield* factories.readVersion(
                input.factoryId,
                workflow.factoryVersionId,
              );
              if (!version.repositories.includes(work.repository))
                return yield* new Factories.AutomationError({ reason: "scope_mismatch" });
              yield* sql`INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,inputs,state) VALUES(${input.id},${input.factoryId},${input.workItemId},${workflow.id},${version.id},${work.repository},${input.revision},${input.inputs ? sql.json(input.inputs) : null},'pending')`.pipe(
                Effect.mapError(storageError),
              );
              yield* sql`INSERT INTO foundry_automation.outbox(id,run_id,kind,payload) VALUES(${input.commandId},${input.id},'run.created',${sql.json({ runId: input.id })})`.pipe(
                Effect.mapError(storageError),
              );
            }),
          );
        }
        return yield* readRun(input.factoryId, input.id);
      }),
    );
  }, Effect.mapError(operationError));
  const readOutbox = Effect.fn("Workflows.readOutbox")(function* (
    factoryId: string,
    runId: string,
  ) {
    yield* readRun(factoryId, runId);
    return yield* sql<AutomationOutboxEntry>`SELECT id,run_id AS "runId",kind,payload FROM foundry_automation.outbox WHERE run_id=${runId} ORDER BY id`;
  }, Effect.mapError(operationError));
  return Workflows.of({ createVersion, readVersion, start, readRun, readOutbox });
});
export const layer = Layer.effect(Workflows, make);
