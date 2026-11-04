import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, ProjectId } from "../baseSchemas.ts";
import { FoundryArtifactManifest } from "../foundryArtifact.ts";
import { FoundryWorkerExecution, FoundryWorkerStatus } from "../foundryWorker.ts";
import { ActivateFactoryDefinition, FactoryDefinitionVersion } from "./definition.ts";
import {
  AutomationFactory,
  AutomationFactoryVersion,
  AutomationRun,
  AutomationWorkItem,
  AutomationWorkflowVersion,
  CreateAutomationWorkItem,
} from "./factory.ts";
import { FoundryDeviceId } from "../foundryDevices.ts";
import { ManualStart, AutomationControlSnapshot } from "./control.ts";

const Key = AutomationFactory.fields.id;
const Page = {
  after: Schema.optional(Key),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
};
const FactoryFilter = { factoryId: Schema.optional(Key) };
export const AutomationApplicationQuery = Schema.Union([
  Schema.Struct({ op: Schema.Literal("workerBinding") }),
  Schema.Struct({
    op: Schema.Literal("factories"),
    ...Page,
    search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({ op: Schema.Literal("factory"), factoryId: Key }),
  Schema.Struct({ op: Schema.Literal("workItems"), factoryId: Key, ...Page }),
  Schema.Struct({ op: Schema.Literal("workItem"), factoryId: Key, workItemId: Key }),
  Schema.Struct({
    op: Schema.Literal("runs"),
    ...FactoryFilter,
    workItemId: Schema.optional(Key),
    state: Schema.optional(AutomationRun.fields.state),
    ...Page,
  }),
  Schema.Struct({ op: Schema.Literal("run"), factoryId: Key, runId: Key }),
  Schema.Struct({ op: Schema.Literal("attempts"), factoryId: Key, runId: Key, ...Page }),
  Schema.Struct({ op: Schema.Literal("attempt"), factoryId: Key, runId: Key, commandId: Key }),
]);
export type AutomationApplicationQuery = typeof AutomationApplicationQuery.Type;
export const AutomationApplicationCommand = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("createFactory"),
    commandId: Key,
    id: Key,
    name: AutomationFactory.fields.name,
    scopeVersionId: Key,
    repositories: AutomationFactoryVersion.fields.repositories,
  }),
  Schema.Struct({ op: Schema.Literal("activateDefinition"), input: ActivateFactoryDefinition }),
  Schema.Struct({ op: Schema.Literal("createWorkItem"), input: CreateAutomationWorkItem }),
  Schema.Struct({ op: Schema.Literal("start"), input: ManualStart }),
]);
export type AutomationApplicationCommand = typeof AutomationApplicationCommand.Type;
export const AutomationAttemptSummary = Schema.Struct({
  commandId: Key,
  ordinal: Schema.Int,
  attemptNumber: Schema.Int,
  state: Schema.String,
  reason: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  environmentId: Schema.NullOr(EnvironmentId),
  hasResult: Schema.Boolean,
});
export type AutomationAttemptSummary = typeof AutomationAttemptSummary.Type;
const Next = { next: Schema.NullOr(Key) };
export const AutomationApplicationResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workerBinding"),
    deviceId: FoundryDeviceId,
    environmentId: EnvironmentId,
    status: FoundryWorkerStatus,
    projects: Schema.Array(
      Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("factories"),
    items: Schema.Array(AutomationFactory),
    ...Next,
  }),
  Schema.Struct({
    kind: Schema.Literal("factory"),
    factory: AutomationFactory,
    versions: Schema.Array(AutomationFactoryVersion),
    active: Schema.NullOr(FactoryDefinitionVersion),
  }),
  Schema.Struct({
    kind: Schema.Literal("workItems"),
    items: Schema.Array(AutomationWorkItem),
    ...Next,
  }),
  Schema.Struct({ kind: Schema.Literal("workItem"), item: AutomationWorkItem }),
  Schema.Struct({ kind: Schema.Literal("runs"), items: Schema.Array(AutomationRun), ...Next }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    run: AutomationRun,
    workflow: AutomationWorkflowVersion,
    control: Schema.NullOr(AutomationControlSnapshot),
  }),
  Schema.Struct({
    kind: Schema.Literal("attempts"),
    items: Schema.Array(AutomationAttemptSummary),
    ...Next,
  }),
  Schema.Struct({
    kind: Schema.Literal("attempt"),
    execution: Schema.NullOr(FoundryWorkerExecution),
    artifacts: Schema.Array(FoundryArtifactManifest),
  }),
  Schema.Struct({ kind: Schema.Literal("definition"), version: FactoryDefinitionVersion }),
]);
export type AutomationApplicationResult = typeof AutomationApplicationResult.Type;
export class AutomationApplicationError extends Schema.TaggedError<AutomationApplicationError>()(
  "AutomationApplicationError",
  {
    code: Schema.Literals(["forbidden", "invalid_input", "conflict", "not_found", "unavailable"]),
  },
) {
  override get message() {
    return `Factory operation failed (${this.code}).`;
  }
}
