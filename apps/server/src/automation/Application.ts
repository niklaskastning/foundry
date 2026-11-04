import {
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
const decodeResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    execution: Schema.NullOr(FoundryWorkerExecution),
    artifacts: Schema.Array(FoundryArtifactManifest),
  }),
);
const error = (cause: unknown) => {
  if (isApplicationError(cause)) return cause;
  if (cause && typeof cause === "object") {
    const reason = "reason" in cause ? cause.reason : "code" in cause ? cause.code : null;
    if (reason === "forbidden" || reason === "not_allowed")
      return new AutomationApplicationError({ code: "forbidden" });
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
  const factories = yield* Factories.Factories;
  const definitions = yield* Definitions.Definitions;
  const workflows = yield* Workflows.Workflows;
  const scheduler = yield* Scheduler.Scheduler;
  const target = yield* Scheduler.SchedulerConfig;
  const control = yield* Control.Control;
  const worker = yield* WorkerTransport.WorkerTransport;
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
  const query = Effect.fn("AutomationApplication.query")(function* (
    request: Request,
    raw: AutomationApplicationQuery,
  ) {
    const input = yield* decodeQuery(raw).pipe(
      Effect.mapError(() => new AutomationApplicationError({ code: "invalid_input" })),
    );
    const identity = yield* worker.identityForRead(request);
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
        case "workerBinding": {
          const identity = yield* worker.authorize(request, target);
          const status = yield* worker.status(identity);
          const grant = yield* gateway.create(request, {
            deviceId: target.deviceId,
            environmentId: target.environmentId,
            scopes: ["orchestration:read"],
          });
          const lookup = {
            deviceId: target.deviceId,
            environmentId: target.environmentId,
            grantId: grant.grantId,
          };
          const snapshot = yield* gateway
            .projects(request, lookup)
            .pipe(Effect.ensuring(gateway.remove(request, lookup).pipe(Effect.ignore)));
          return {
            kind: "workerBinding" as const,
            deviceId: target.deviceId,
            environmentId: target.environmentId,
            status,
            projects: snapshot.projects
              .filter((project) => !project.deletedAt && !project.archivedAt)
              .map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
          };
        }
        case "factories": {
          const rows =
            yield* sql<AutomationFactory>`SELECT id,name,archived FROM foundry_automation.factories WHERE id>${input.after ?? ""} AND (${input.search ?? ""}='' OR position(lower(${input.search ?? ""}) in lower(name))>0) ORDER BY id LIMIT ${input.limit + 1}`;
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
            yield* sql<AutomationWorkItem>`SELECT id,factory_id AS "factoryId",version_id AS "versionId",repository,title,source,state FROM foundry_automation.work_items WHERE factory_id=${input.factoryId} AND id>${input.after ?? ""} ORDER BY id LIMIT ${input.limit + 1}`;
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
          const rows =
            yield* sql<AutomationRun>`SELECT r.id,r.factory_id AS "factoryId",r.work_item_id AS "workItemId",r.workflow_version_id AS "workflowVersionId",r.factory_version_id AS "factoryVersionId",r.repository,r.revision,CASE WHEN c.mode IS NOT NULL AND c.mode<>'active' THEN c.mode ELSE COALESCE(d.state,r.state) END AS state FROM foundry_automation.runs r LEFT JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id LEFT JOIN foundry_automation.run_controls c ON c.run_id=r.id WHERE r.id>${input.after ?? ""} AND (d.run_id IS NULL OR (d.binding->'identity'->>'instanceId'=${identity.instanceId} AND d.binding->'identity'->>'operatorId'=${identity.operatorId})) AND (${input.factoryId ?? null}::text IS NULL OR r.factory_id=${input.factoryId ?? null}) AND (${input.workItemId ?? null}::text IS NULL OR r.work_item_id=${input.workItemId ?? null}) AND (${input.state ?? null}::text IS NULL OR CASE WHEN c.mode IS NOT NULL AND c.mode<>'active' THEN c.mode ELSE COALESCE(d.state,r.state) END=${input.state ?? null}) ORDER BY r.id LIMIT ${input.limit + 1}`;
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
            run,
            workflow: yield* workflows.readVersion(input.factoryId, run.workflowVersionId),
            control: enrolled ? yield* control.read(request, input.factoryId, input.runId) : null,
          };
        }
        case "attempts": {
          yield* ownedRun(input.runId);
          yield* workflows.readRun(input.factoryId, input.runId);
          const rows =
            yield* sql<AutomationAttemptSummary>`SELECT a.command_id AS "commandId",a.ordinal,a.attempt_number AS "attemptNumber",a.state,a.reason,a.receipt->'receipt'->>'threadId' AS "threadId",d.binding->'identity'->>'environmentId' AS "environmentId",a.result IS NOT NULL AS "hasResult" FROM foundry_automation.step_attempts a JOIN foundry_automation.dispatch_runs d ON d.run_id=a.run_id WHERE a.run_id=${input.runId} AND a.command_id>${input.after ?? ""} ORDER BY a.command_id LIMIT ${input.limit + 1}`;
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
          }>`SELECT result FROM foundry_automation.step_attempts WHERE run_id=${input.runId} AND command_id=${input.commandId}`;
          if (!rows[0]) return yield* new AutomationApplicationError({ code: "not_found" });
          const parsed = yield* decodeResult(rows[0].result ?? { execution: null, artifacts: [] });
          return { kind: "attempt" as const, ...parsed };
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
    const scope =
      input.op === "createFactory" || input.op === "activateDefinition"
        ? "access:write"
        : "orchestration:operate";
    yield* gateway.identityForWrite(request, scope);
    switch (input.op) {
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
