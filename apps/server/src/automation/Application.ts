import * as MachineAccess from "./MachineAccess.ts";
import * as Handoffs from "./Handoffs.ts";
import * as DefinitionSources from "./DefinitionSources.ts";
import {
  ManualStart,
  FactoryExecutionDefaults,
  FoundryWorkerLaunchInput,
  AutomationApplicationCommand,
  AutomationApplicationError,
  AutomationApplicationQuery,
  AutomationApplicationResult,
  AutomationAttemptSummary,
  AutomationFactory,
  AutomationFactoryVersion,
  AutomationRun,
  AutomationWorkItem,
  FoundryWorkerExecution,
  FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as Control from "./Control.ts";
import * as Definitions from "./Definitions.ts";
import * as Factories from "./Factories.ts";
import * as Scheduler from "./Scheduler.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as Workflows from "./Workflows.ts";

type Request = HttpServerRequest.HttpServerRequest;
const isApplicationError = Schema.is(AutomationApplicationError);
const decodeQuery = Schema.decodeEffect(AutomationApplicationQuery, { onExcessProperty: "error" });
const decodeCommand = Schema.decodeEffect(AutomationApplicationCommand, {
  onExcessProperty: "error",
});
const decodeDefaults = Schema.decodeUnknownEffect(FactoryExecutionDefaults);
const decodeLaunch = Schema.decodeUnknownOption(FoundryWorkerLaunchInput);
const decodeExecutionBinding = Schema.decodeUnknownEffect(
  Schema.Struct({
    workers: ManualStart.fields.workers,
    projectId: ManualStart.fields.projectId,
    model: ManualStart.fields.model,
    checks: ManualStart.fields.checks,
    requiredArtifacts: ManualStart.fields.requiredArtifacts,
  }),
);
const decodeResult = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      execution: Schema.NullOr(FoundryWorkerExecution),
      artifacts: Schema.Array(FoundryArtifactManifest),
    }),
    Schema.Struct({
      publish: Schema.Struct({
        number: Schema.Int,
        url: Schema.String,
        commitSha: Schema.String,
        operationKey: Schema.String,
      }),
    }),
  ]),
);
const error = (cause: unknown) => {
  if (isApplicationError(cause)) return cause;
  if (cause && typeof cause === "object") {
    const reason = "reason" in cause ? cause.reason : "code" in cause ? cause.code : null;
    if (reason === "forbidden" || reason === "not_allowed")
      return new AutomationApplicationError({ code: "forbidden" });
    if (
      reason === "unsupported_provider" ||
      reason === "worker_not_ready" ||
      reason === "invalid_execution"
    )
      return new AutomationApplicationError({ code: reason });
    if (reason === "not_found") return new AutomationApplicationError({ code: "not_found" });
    if (
      reason === "invalid_input" ||
      reason === "invalid_definition" ||
      reason === "invalid_binding"
    )
      return new AutomationApplicationError({ code: "invalid_input" });
    if (
      reason === "version_conflict" ||
      reason === "command_conflict" ||
      reason === "conflict" ||
      reason === "archived" ||
      reason === "scope_mismatch"
    )
      return new AutomationApplicationError({ code: "conflict" });
  }
  return new AutomationApplicationError({ code: "unavailable" });
};
export class Application extends Context.Service<
  Application,
  {
    readonly query: (
      request: Request,
      input: AutomationApplicationQuery,
    ) => Effect.Effect<AutomationApplicationResult, AutomationApplicationError>;
    readonly command: (
      request: Request,
      input: AutomationApplicationCommand,
    ) => Effect.Effect<AutomationApplicationResult, AutomationApplicationError>;
  }
>()("t3/automation/Application") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const machineAccess = yield* MachineAccess.MachineAccess;
  const handoffs = yield* Handoffs.Handoffs;
  const factories = yield* Factories.Factories;
  const definitions = yield* Definitions.Definitions;
  const sources = yield* DefinitionSources.DefinitionSources;
  const runBinding = Effect.fn("AutomationApplication.runBinding")(function* (runId: string) {
    const rows = yield* sql<{
      binding: unknown;
    }>`SELECT binding FROM foundry_automation.dispatch_runs WHERE run_id=${runId}`;
    return rows[0] ? yield* decodeExecutionBinding(rows[0].binding) : null;
  });
  const runDefinition = Effect.fn("AutomationApplication.runDefinition")(function* (
    factoryId: string,
    factoryVersionId: string,
  ) {
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM foundry_automation.definition_versions WHERE factory_id=${factoryId} AND factory_version_id=${factoryVersionId}`;
    return rows[0] ? yield* definitions.readVersion(factoryId, rows[0].id) : null;
  });
  const workflows = yield* Workflows.Workflows;
  const scheduler = yield* Scheduler.Scheduler;
  const target = yield* Scheduler.SchedulerConfig;
  const control = yield* Control.Control;
  const worker = yield* WorkerTransport.WorkerTransport;
  const dispatch = yield* DispatchStore.DispatchStore;
  const gateway = yield* GatewayGrants.GatewayGrants;
  const factory = Effect.fn("AutomationApplication.factory")(function* (factoryId: string) {
    const item = yield* factories.readFactory(factoryId);
    const versions =
      yield* sql<AutomationFactoryVersion>`SELECT id,factory_id AS "factoryId",repositories FROM foundry_automation.versions WHERE factory_id=${factoryId} ORDER BY id LIMIT 50`;
    return {
      kind: "factory" as const,
      factory: item,
      versions,
      active: Option.getOrNull(yield* definitions.active(factoryId)),
    };
  });
  const executionDefaults = Effect.fn("AutomationApplication.executionDefaults")(function* (
    factoryId: string,
    repository: string,
    identity: { instanceId: string; operatorId: string },
  ) {
    yield* factories.readFactory(factoryId);
    const rows = yield* sql<{
      defaults: unknown;
    }>`SELECT settings || jsonb_build_object('factoryId',factory_id,'repository',repository,'generation',generation) AS defaults FROM foundry_automation.execution_defaults WHERE factory_id=${factoryId} AND repository=${repository} AND instance_id=${identity.instanceId} AND operator_id=${identity.operatorId}`;
    return rows[0] ? yield* decodeDefaults(rows[0].defaults) : null;
  });
  const configureExecutionDefaults = Effect.fn("AutomationApplication.configureExecutionDefaults")(
    function* (
      input: Extract<AutomationApplicationCommand, { op: "configureExecutionDefaults" }>,
      identity: { instanceId: string; operatorId: string },
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const locked =
            yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${input.factoryId} AND NOT archived FOR UPDATE`;
          if (!locked.length) return yield* new AutomationApplicationError({ code: "not_found" });
          const receipt = yield* sql<{
            same: boolean;
            result: unknown;
          }>`SELECT payload=${sql.json(input)}::jsonb AND instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} AS same,result FROM foundry_automation.execution_defaults_commands WHERE id=${input.commandId}`;
          if (receipt[0]) {
            if (!receipt[0].same)
              return yield* new AutomationApplicationError({ code: "conflict" });
            return yield* decodeDefaults(receipt[0].result);
          }
          const active = Option.getOrNull(yield* definitions.active(input.factoryId));
          if (!active?.definition.repositories.includes(input.repository))
            return yield* new AutomationApplicationError({ code: "invalid_input" });
          const existing = yield* sql<{
            generation: number;
            owned: boolean;
          }>`SELECT generation,instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} AS owned FROM foundry_automation.execution_defaults WHERE factory_id=${input.factoryId} AND repository=${input.repository}`;
          if (
            (existing[0]?.generation ?? null) !== input.expectedGeneration ||
            (existing[0] && !existing[0].owned)
          )
            return yield* new AutomationApplicationError({ code: "conflict" });
          const settings = {
            ...(input.workers ? { workers: input.workers } : {}),
            projectId: input.projectId,
            model: input.model,
            checks: input.checks,
            requiredArtifacts: input.requiredArtifacts,
          };
          const defaults = {
            factoryId: input.factoryId,
            repository: input.repository,
            generation: (input.expectedGeneration ?? 0) + 1,
            ...settings,
          };
          yield* sql`INSERT INTO foundry_automation.execution_defaults(factory_id,repository,generation,instance_id,operator_id,settings) VALUES(${input.factoryId},${input.repository},${defaults.generation},${identity.instanceId},${identity.operatorId},${sql.json(settings)}) ON CONFLICT(factory_id,repository) DO UPDATE SET generation=EXCLUDED.generation,settings=EXCLUDED.settings`;
          yield* sql`INSERT INTO foundry_automation.execution_defaults_commands(id,payload,result,instance_id,operator_id) VALUES(${input.commandId},${sql.json(input)},${sql.json(defaults)},${identity.instanceId},${identity.operatorId})`;
          return defaults;
        }),
      );
    },
  );
  const query = Effect.fn("AutomationApplication.query")(function* (
    request: Request,
    raw: AutomationApplicationQuery,
  ) {
    const input = yield* decodeQuery(raw).pipe(
      Effect.mapError(() => new AutomationApplicationError({ code: "invalid_input" })),
    );
    const identity = yield* machineAccess.read(request);
    const allowed = identity.factoryIds;
    if (allowed) {
      if (
        !(
          [
            "factories",
            "factory",
            "workItems",
            "workItem",
            "runs",
            "run",
            "attempts",
            "attempt",
          ] as ReadonlyArray<string>
        ).includes(input.op)
      )
        return yield* new AutomationApplicationError({ code: "forbidden" });
      if (
        "factoryId" in input &&
        input.factoryId !== undefined &&
        !allowed.includes(input.factoryId)
      )
        return yield* new AutomationApplicationError({ code: "forbidden" });
    }
    const ownedRun = Effect.fn("AutomationApplication.ownedRun")(function* (runId: string) {
      const bindings = yield* sql<{
        owned: boolean;
      }>`SELECT binding->'identity'->>'instanceId'=${identity.instanceId} AND binding->'identity'->>'operatorId'=${identity.operatorId} AS owned FROM foundry_automation.dispatch_runs WHERE run_id=${runId}`;
      if (bindings.length && !bindings[0]?.owned)
        return yield* new AutomationApplicationError({ code: "forbidden" });
      return bindings.length > 0;
    });
    const result = yield* Effect.gen(function* () {
      switch (input.op) {
        case "executionDefaults":
          return {
            kind: "executionDefaults" as const,
            defaults: yield* executionDefaults(input.factoryId, input.repository, identity),
          };
        case "handoffs":
          return { kind: "handoffs" as const, items: yield* handoffs.query(request, input) };
        case "threadHandoff":
          return {
            kind: "handoff" as const,
            handoff: (yield* handoffs.query(request, input))[0] ?? null,
          };
        case "definitionSource":
          return {
            kind: "definitionSource" as const,
            binding: yield* sources.source(input.factoryId),
          };
        case "definitionRevisions":
          return {
            kind: "definitionRevisions" as const,
            ...(yield* sources.listRevisions(input.factoryId, input.after, input.limit)),
          };
        case "definitionRevision": {
          const detail = yield* sources.readRevision(input.factoryId, input.revisionId);
          return {
            kind: "definitionRevision" as const,
            revision: detail.revision,
            files: detail.files.map((file) => file.path),
            activeFiles: detail.activeFiles?.map((file) => file.path) ?? null,
            activeVersionId: detail.activeVersionId,
          };
        }
        case "definitionRevisionFile": {
          const detail = yield* sources.readRevision(input.factoryId, input.revisionId);
          const files =
            input.side === "revision"
              ? detail.files
              : input.activeVersionId
                ? yield* definitions.exportVersion(input.factoryId, input.activeVersionId)
                : [];
          return {
            kind: "definitionRevisionFile" as const,
            file: files.find((file) => file.path === input.path) ?? null,
          };
        }
        case "workerBinding": {
          const targets = [target, ...(target.workers ?? [])];
          const selected = input.deviceId
            ? targets.find((entry) => entry.deviceId === input.deviceId)
            : target;
          if (!selected) return yield* new AutomationApplicationError({ code: "forbidden" });
          const identity = yield* worker.authorize(request, selected);
          const status = yield* worker.status(identity);
          const capacity = yield* dispatch.workerCapacity(selected.deviceId);
          const grant = yield* gateway.create(request, {
            deviceId: selected.deviceId,
            environmentId: selected.environmentId,
            scopes: ["orchestration:read"],
          });
          const lookup = {
            deviceId: selected.deviceId,
            environmentId: selected.environmentId,
            grantId: grant.grantId,
          };
          const snapshot = yield* gateway
            .projects(request, lookup)
            .pipe(Effect.ensuring(gateway.remove(request, lookup).pipe(Effect.ignore)));
          return {
            kind: "workerBinding" as const,
            deviceId: selected.deviceId,
            environmentId: selected.environmentId,
            status,
            paused: capacity?.paused ?? false,
            reserved: capacity?.occupied ?? 0,
            workers: targets.map(({ deviceId, environmentId }) => ({ deviceId, environmentId })),
            projects: snapshot.projects
              .filter((project) => !project.deletedAt && !project.archivedAt)
              .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
          };
        }
        case "factories": {
          const rows =
            yield* sql<AutomationFactory>`SELECT id,name,archived FROM foundry_automation.factories WHERE (${allowed ? sql.json(allowed) : null}::jsonb IS NULL OR ${allowed ? sql.json(allowed) : null}::jsonb ? id) AND id>${input.after ?? ""} AND (${input.search ?? ""}='' OR position(lower(${input.search ?? ""}) in lower(name))>0) ORDER BY id LIMIT ${input.limit + 1}`;
          const items = rows.slice(0, input.limit);
          return {
            kind: "factories" as const,
            items,
            next: rows.length > input.limit ? items.at(-1)!.id : null,
          };
        }
        case "factory":
          return yield* factory(input.factoryId);
        case "workItems": {
          yield* factories.readFactory(input.factoryId);
          const rows =
            yield* sql<AutomationWorkItem>`SELECT id,factory_id AS "factoryId",version_id AS "versionId",repository,title,source,state FROM foundry_automation.work_items WHERE factory_id=${input.factoryId} AND (NOT ${input.activeOnly ?? false} OR state NOT IN ('completed','cancelled')) AND id>${input.after ?? ""} ORDER BY id LIMIT ${input.limit + 1}`;
          const items = rows.slice(0, input.limit);
          return {
            kind: "workItems" as const,
            items,
            next: rows.length > input.limit ? items.at(-1)!.id : null,
          };
        }
        case "workItem":
          return {
            kind: "workItem" as const,
            item: yield* factories.readWorkItem(input.factoryId, input.workItemId),
          };
        case "runs": {
          const rows = yield* sql<
            AutomationRun & { workItemTitle: string }
          >`SELECT w.title AS "workItemTitle",r.id,r.factory_id AS "factoryId",r.work_item_id AS "workItemId",r.workflow_version_id AS "workflowVersionId",r.factory_version_id AS "factoryVersionId",r.repository,r.revision,CASE WHEN c.mode IS NOT NULL AND c.mode<>'active' THEN c.mode ELSE COALESCE(d.state,r.state) END AS state FROM foundry_automation.runs r JOIN foundry_automation.work_items w ON w.factory_id=r.factory_id AND w.id=r.work_item_id LEFT JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id LEFT JOIN foundry_automation.run_controls c ON c.run_id=r.id WHERE (${allowed ? sql.json(allowed) : null}::jsonb IS NULL OR ${allowed ? sql.json(allowed) : null}::jsonb ? r.factory_id) AND (CASE WHEN ${input.recent ?? false} THEN d.enrolled_at IS NOT NULL AND (${input.after ?? null}::text IS NULL OR (d.enrolled_at,r.id)<((SELECT enrolled_at FROM foundry_automation.dispatch_runs WHERE run_id=${input.after ?? null}),${input.after ?? null})) ELSE r.id>${input.after ?? ""} END) AND (d.run_id IS NULL OR (d.binding->'identity'->>'instanceId'=${identity.instanceId} AND d.binding->'identity'->>'operatorId'=${identity.operatorId})) AND (${input.factoryId ?? null}::text IS NULL OR r.factory_id=${input.factoryId ?? null}) AND (${input.workItemId ?? null}::text IS NULL OR r.work_item_id=${input.workItemId ?? null}) AND (${input.state ?? null}::text IS NULL OR CASE WHEN c.mode IS NOT NULL AND c.mode<>'active' THEN c.mode ELSE COALESCE(d.state,r.state) END=${input.state ?? null}) ORDER BY CASE WHEN ${input.recent ?? false} THEN d.enrolled_at END DESC,CASE WHEN ${input.recent ?? false} THEN r.id END DESC,r.id LIMIT ${input.limit + 1}`;
          const items = rows.slice(0, input.limit);
          return {
            kind: "runs" as const,
            items,
            next: rows.length > input.limit ? items.at(-1)!.id : null,
          };
        }
        case "run": {
          const enrolled = yield* ownedRun(input.runId);
          const run = yield* workflows.readRun(input.factoryId, input.runId);
          return {
            kind: "run" as const,
            factoryName: (yield* factories.readFactory(run.factoryId)).name,
            workItem: yield* factories.readWorkItem(run.factoryId, run.workItemId),
            executionBinding: yield* runBinding(run.id),
            definition: yield* runDefinition(run.factoryId, run.factoryVersionId),
            run,
            workflow: yield* workflows.readVersion(input.factoryId, run.workflowVersionId),
            control: enrolled
              ? yield* control.readAuthorized(identity, input.factoryId, input.runId)
              : null,
          };
        }
        case "attempts": {
          yield* ownedRun(input.runId);
          yield* workflows.readRun(input.factoryId, input.runId);
          const rows =
            yield* sql<AutomationAttemptSummary>`SELECT a.command_id AS "commandId",a.ordinal,a.attempt_number AS "attemptNumber",a.state,a.reason,a.receipt->'receipt'->>'threadId' AS "threadId",COALESCE(a.worker_binding->'identity'->>'environmentId',d.binding->'identity'->>'environmentId') AS "environmentId",a.worker_id AS "workerId",a.capacity_released AS "capacityReleased",a.result IS NOT NULL AS "hasResult" FROM foundry_automation.step_attempts a JOIN foundry_automation.dispatch_runs d ON d.run_id=a.run_id WHERE a.run_id=${input.runId} AND a.command_id>${input.after ?? ""} ORDER BY a.command_id LIMIT ${input.limit + 1}`;
          const items = rows.slice(0, input.limit);
          return {
            kind: "attempts" as const,
            items,
            next: rows.length > input.limit ? items.at(-1)!.commandId : null,
          };
        }
        case "attempt": {
          yield* ownedRun(input.runId);
          yield* workflows.readRun(input.factoryId, input.runId);
          const rows = yield* sql<{
            result: unknown;
            request: unknown;
          }>`SELECT result,request FROM foundry_automation.step_attempts WHERE run_id=${input.runId} AND command_id=${input.commandId}`;
          if (!rows[0]) return yield* new AutomationApplicationError({ code: "not_found" });
          const parsed = yield* decodeResult(rows[0].result ?? { execution: null, artifacts: [] });
          return {
            kind: "attempt" as const,
            launch: Option.getOrNull(decodeLaunch(rows[0].request)),
            ...("publish" in parsed ? { ...parsed, execution: null, artifacts: [] } : parsed),
          };
        }
      }
    });
    return result;
  }, Effect.mapError(error));
  const command = Effect.fn("AutomationApplication.command")(function* (
    request: Request,
    raw: AutomationApplicationCommand,
  ) {
    const input = yield* decodeCommand(raw).pipe(
      Effect.mapError(() => new AutomationApplicationError({ code: "invalid_input" })),
    );
    const scope = [
      "setWorkerPaused",
      "createFactory",
      "configureExecutionDefaults",
      "activateDefinition",
      "configureDefinitionSource",
      "syncDefinitionSource",
      "setDefinitionSourceEnabled",
      "activateDefinitionRevision",
    ].includes(input.op)
      ? "access:write"
      : "orchestration:operate";
    const identity = yield* gateway.identityForWrite(request, scope);
    switch (input.op) {
      case "setWorkerPaused": {
        const selected = [target, ...(target.workers ?? [])].find(
          (entry) => entry.deviceId === input.deviceId,
        );
        if (!selected) return yield* new AutomationApplicationError({ code: "forbidden" });
        const authorized = yield* worker.authorize(request, selected);
        const status = yield* worker.status(authorized);
        const capacity = yield* dispatch.configureWorker({
          workerId: selected.deviceId,
          capacity: status.capacity ?? 1,
          paused: input.paused,
        });
        return { kind: "workerCapacity" as const, ...capacity, workerId: selected.deviceId };
      }
      case "configureExecutionDefaults":
        return {
          kind: "executionDefaults" as const,
          defaults: yield* configureExecutionDefaults(input, identity),
        };
      case "takeOver":
      case "returnHandoff":
      case "reopenHandoff":
        return { kind: "handoff" as const, handoff: yield* handoffs.execute(request, input) };
      case "configureDefinitionSource":
        return {
          kind: "definitionSource" as const,
          binding: yield* sources.configure(input, identity),
        };
      case "syncDefinitionSource":
        return {
          kind: "definitionSource" as const,
          binding: yield* sources.requestSync(input, identity),
        };
      case "setDefinitionSourceEnabled":
        return {
          kind: "definitionSource" as const,
          binding: yield* sources.setEnabled(input, identity),
        };
      case "activateDefinitionRevision":
        return {
          kind: "definition" as const,
          version: yield* sources.activateRevision(input, identity),
        };
      case "createFactory":
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* factories.createFactory({
              commandId: input.commandId,
              id: input.id,
              name: input.name,
            });
            yield* factories.createVersion({
              commandId: `scope:${input.commandId}`,
              id: input.scopeVersionId,
              factoryId: input.id,
              repositories: input.repositories,
            });
          }),
        );
        return yield* factory(input.id);
      case "activateDefinition":
        return { kind: "definition" as const, version: yield* definitions.activate(input.input) };
      case "createWorkItem":
        return { kind: "workItem" as const, item: yield* factories.createWorkItem(input.input) };
      case "start": {
        yield* scheduler.start(request, input.input);
        const run = yield* workflows.readRun(input.input.factoryId, input.input.id);
        return {
          kind: "run" as const,
          factoryName: (yield* factories.readFactory(run.factoryId)).name,
          workItem: yield* factories.readWorkItem(run.factoryId, run.workItemId),
          executionBinding: yield* runBinding(run.id),
          definition: yield* runDefinition(run.factoryId, run.factoryVersionId),
          run,
          workflow: yield* workflows.readVersion(input.input.factoryId, run.workflowVersionId),
          control: yield* control.read(request, input.input.factoryId, input.input.id),
        };
      }
    }
  }, Effect.mapError(error));
  return Application.of({ query, command });
});
export const layer = Layer.effect(Application, make);
