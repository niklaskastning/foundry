import { OperationsDashboardQuery, OperationsDashboard } from "./operationsDashboard.ts";
import { RequestEvaluation, EvaluationResult, EvaluationSummary } from "./evaluation.ts";
import { FactoryV4Workflow, FactoryV4ResolvedAgent } from "./definitionV4.ts";
import { FactoryMcpBinding, SetFactoryMcpBinding } from "./mcpBinding.ts";
import { FactoryV4RunState, FactoryV4NodeState } from "./executionV4.ts";
import { AutomationHandoff, AutomationHandoffCommand, AutomationHandoffQuery } from "./handoff.ts";
import {
  FactoryDefinitionSourceBinding,
  FactoryDefinitionGitRevision,
  ConfigureDefinitionSource,
  SyncDefinitionSource,
  SetDefinitionSourceEnabled,
  ActivateDefinitionRevision,
} from "./definitionSource.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, ProjectId } from "../baseSchemas.ts";
import { FoundryArtifactManifest } from "../foundryArtifact.ts";
import {
  FoundryWorkerExecution,
  FoundryWorkerStatus,
  FoundryWorkerLaunchInput,
} from "../foundryWorker.ts";
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
export const FactoryExecutionDefaults = Schema.Struct({
  factoryId: Key,
  repository: Key,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  sandbox: ManualStart.fields.sandbox,
  workers: ManualStart.fields.workers,
  projectId: ManualStart.fields.projectId,
  model: ManualStart.fields.model,
  checks: ManualStart.fields.checks,
  requiredArtifacts: ManualStart.fields.requiredArtifacts,
});
export type FactoryExecutionDefaults = typeof FactoryExecutionDefaults.Type;
const Page = {
  after: Schema.optional(Key),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
};
const FactoryFilter = { factoryId: Schema.optional(Key) };
export const AutomationApplicationQuery = Schema.Union([
  OperationsDashboardQuery,
  Schema.Struct({ op: Schema.Literal("evaluation"), factoryId: Key, id: Key }),
  Schema.Struct({
    op: Schema.Literal("evaluations"),
    factoryId: Schema.optional(Key),
    runId: Schema.optional(Key),
    after: Schema.optional(Key),
  }),
  Schema.Struct({ op: Schema.Literal("mcpBindings"), factoryId: Key }),
  ...AutomationHandoffQuery.members,
  Schema.Struct({ op: Schema.Literal("executionDefaults"), factoryId: Key, repository: Key }),
  Schema.Struct({
    op: Schema.Literal("definitionRevisionFile"),
    factoryId: Key,
    revisionId: Key,
    path: Schema.String.check(Schema.isMaxLength(240)),
    side: Schema.Literals(["revision", "active"]),
    activeVersionId: Schema.NullOr(Key),
  }),
  Schema.Struct({ op: Schema.Literal("definitionSource"), factoryId: Key }),
  Schema.Struct({ op: Schema.Literal("definitionRevisions"), factoryId: Key, ...Page }),
  Schema.Struct({ op: Schema.Literal("definitionRevision"), factoryId: Key, revisionId: Key }),
  Schema.Struct({
    op: Schema.Literal("workerBinding"),
    deviceId: Schema.optional(FoundryDeviceId),
  }),
  Schema.Struct({
    op: Schema.Literal("factories"),
    ...Page,
    search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({ op: Schema.Literal("factory"), factoryId: Key }),
  Schema.Struct({
    op: Schema.Literal("workItems"),
    factoryId: Key,
    activeOnly: Schema.optional(Schema.Boolean),
    ...Page,
  }),
  Schema.Struct({ op: Schema.Literal("workItem"), factoryId: Key, workItemId: Key }),
  Schema.Struct({
    op: Schema.Literal("runs"),
    recent: Schema.optional(Schema.Boolean),
    ...FactoryFilter,
    workItemId: Schema.optional(Key),
    state: Schema.optional(AutomationRun.fields.state),
    ...Page,
  }),
  Schema.Struct({
    op: Schema.Literal("run"),
    factoryId: Key,
    runId: Key,
    nodesAfter: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20000 }))),
  }),
  Schema.Struct({
    op: Schema.Literal("runtimeNode"),
    factoryId: Key,
    runId: Key,
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({ op: Schema.Literal("attempts"), factoryId: Key, runId: Key, ...Page }),
  Schema.Struct({ op: Schema.Literal("attempt"), factoryId: Key, runId: Key, commandId: Key }),
]);
export type AutomationApplicationQuery = typeof AutomationApplicationQuery.Type;
export const AutomationApplicationCommand = Schema.Union([
  Schema.Struct({ op: Schema.Literal("evaluateRun"), input: RequestEvaluation }),
  Schema.Struct({ op: Schema.Literal("setMcpBinding"), input: SetFactoryMcpBinding }),
  Schema.Struct({
    op: Schema.Literal("setWorkerPaused"),
    deviceId: FoundryDeviceId,
    paused: Schema.Boolean,
  }),
  ...AutomationHandoffCommand.members,
  Schema.Struct({
    op: Schema.Literal("configureExecutionDefaults"),
    factoryId: Key,
    repository: Key,
    sandbox: ManualStart.fields.sandbox,
    workers: ManualStart.fields.workers,
    projectId: ManualStart.fields.projectId,
    model: ManualStart.fields.model,
    checks: ManualStart.fields.checks,
    requiredArtifacts: ManualStart.fields.requiredArtifacts,
    commandId: Key,
    expectedGeneration: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    op: Schema.Literal("configureDefinitionSource"),
    ...ConfigureDefinitionSource.fields,
  }),
  Schema.Struct({ op: Schema.Literal("syncDefinitionSource"), ...SyncDefinitionSource.fields }),
  Schema.Struct({
    op: Schema.Literal("setDefinitionSourceEnabled"),
    ...SetDefinitionSourceEnabled.fields,
  }),
  Schema.Struct({
    op: Schema.Literal("activateDefinitionRevision"),
    ...ActivateDefinitionRevision.fields,
  }),
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
  workerId: Schema.optional(Schema.NullOr(FoundryDeviceId)),
  capacityReleased: Schema.optional(Schema.Boolean),
});
export type AutomationAttemptSummary = typeof AutomationAttemptSummary.Type;
const Next = { next: Schema.NullOr(Key) };
export const AutomationApplicationResult = Schema.Union([
  OperationsDashboard,
  Schema.Struct({ kind: Schema.Literal("evaluations"), items: Schema.Array(EvaluationSummary) }),
  Schema.Struct({ kind: Schema.Literal("evaluation"), result: EvaluationResult }),
  Schema.Struct({ kind: Schema.Literal("evaluationQueued"), id: Key }),
  Schema.Struct({ kind: Schema.Literal("mcpBindings"), items: Schema.Array(FactoryMcpBinding) }),
  Schema.Struct({ kind: Schema.Literal("mcpBinding"), binding: FactoryMcpBinding }),
  Schema.Struct({
    kind: Schema.Literal("workerCapacity"),
    workerId: FoundryDeviceId,
    capacity: Schema.Int,
    occupied: Schema.Int,
    paused: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("executionDefaults"),
    defaults: Schema.NullOr(FactoryExecutionDefaults),
  }),
  Schema.Struct({ kind: Schema.Literal("handoffs"), items: Schema.Array(AutomationHandoff) }),
  Schema.Struct({ kind: Schema.Literal("handoff"), handoff: Schema.NullOr(AutomationHandoff) }),
  Schema.Struct({
    kind: Schema.Literal("definitionSource"),
    binding: Schema.NullOr(FactoryDefinitionSourceBinding),
  }),
  Schema.Struct({
    kind: Schema.Literal("definitionRevisions"),
    items: Schema.Array(FactoryDefinitionGitRevision),
    ...Next,
  }),
  Schema.Struct({
    kind: Schema.Literal("definitionRevision"),
    revision: FactoryDefinitionGitRevision,
    files: Schema.Array(Schema.String),
    activeFiles: Schema.NullOr(Schema.Array(Schema.String)),
    activeVersionId: Schema.NullOr(Key),
  }),
  Schema.Struct({
    kind: Schema.Literal("definitionRevisionFile"),
    file: Schema.NullOr(
      Schema.Struct({
        path: Schema.String,
        content: Schema.String,
        encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
        mode: Schema.optional(Schema.Literals(["100644", "100755"])),
        sha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
        size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("workerBinding"),
    deviceId: FoundryDeviceId,
    environmentId: EnvironmentId,
    status: FoundryWorkerStatus,
    paused: Schema.optional(Schema.Boolean),
    reserved: Schema.optional(Schema.Int),
    workers: Schema.optional(
      Schema.Array(Schema.Struct({ deviceId: FoundryDeviceId, environmentId: EnvironmentId })),
    ),
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
  Schema.Struct({
    kind: Schema.Literal("runs"),
    items: Schema.Array(
      Schema.Struct({
        ...AutomationRun.fields,
        workItemTitle: Schema.optional(Schema.String),
        workflowName: Schema.optional(Schema.NullOr(Schema.String)),
        enrolledAt: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    ...Next,
  }),
  Schema.Struct({
    kind: Schema.Literal("run"),
    factoryName: Schema.optional(Schema.String),
    workItem: Schema.optional(AutomationWorkItem),
    executionBinding: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          sandbox: ManualStart.fields.sandbox,
          workers: ManualStart.fields.workers,
          projectId: ManualStart.fields.projectId,
          model: ManualStart.fields.model,
          checks: ManualStart.fields.checks,
          requiredArtifacts: ManualStart.fields.requiredArtifacts,
        }),
      ),
    ),
    definition: Schema.NullOr(
      Schema.Struct({
        id: FactoryDefinitionVersion.fields.id,
        contentHash: FactoryDefinitionVersion.fields.contentHash,
        source: FactoryDefinitionVersion.fields.source,
      }),
    ),
    run: AutomationRun,
    workflow: Schema.Struct({
      id: AutomationWorkflowVersion.fields.id,
      factoryId: AutomationWorkflowVersion.fields.factoryId,
      factoryVersionId: AutomationWorkflowVersion.fields.factoryVersionId,
      steps: AutomationWorkflowVersion.fields.steps,
      execution: AutomationWorkflowVersion.fields.execution,
    }),
    runtimeWorkflow: Schema.optional(Schema.Struct({ limits: FactoryV4Workflow.fields.limits })),
    runtimeState: Schema.optional(
      Schema.Struct({
        status: FactoryV4RunState.fields.status,
        reason: FactoryV4RunState.fields.reason,
        startedAgentExecutions: FactoryV4RunState.fields.startedAgentExecutions,
        nodes: Schema.Array(
          Schema.Struct({
            path: FactoryV4NodeState.fields.path,
            scope: FactoryV4NodeState.fields.scope,
            definition: Schema.Struct({
              id: Schema.String,
              kind: Schema.Literals(["agent", "test", "approval", "publish", "swarm", "loop"]),
            }),
            status: FactoryV4NodeState.fields.status,
            ordinal: FactoryV4NodeState.fields.ordinal,
            condition: FactoryV4NodeState.fields.condition,
            until: FactoryV4NodeState.fields.until,
            iteration: FactoryV4NodeState.fields.iteration,
            base: FactoryV4NodeState.fields.base,
            checkpoint: FactoryV4NodeState.fields.checkpoint,
            workspaceCheckpoint: FactoryV4NodeState.fields.workspaceCheckpoint,
            reason: FactoryV4NodeState.fields.reason,
            cancelRequested: FactoryV4NodeState.fields.cancelRequested,
            approvalPath: FactoryV4NodeState.fields.approvalPath,
          }),
        ).check(Schema.isMaxLength(100)),
        nodesTotal: Schema.Int,
        nextNodeOffset: Schema.NullOr(Schema.Int),
      }),
    ),
    control: Schema.NullOr(AutomationControlSnapshot),
  }),
  Schema.Struct({ kind: Schema.Literal("runtimeNode"), node: FactoryV4NodeState }),
  Schema.Struct({
    kind: Schema.Literal("attempts"),
    items: Schema.Array(AutomationAttemptSummary),
    ...Next,
  }),
  Schema.Struct({
    kind: Schema.Literal("attempt"),
    launch: Schema.optional(Schema.NullOr(FoundryWorkerLaunchInput)),
    resources: Schema.optional(
      Schema.Struct({
        agent: FactoryV4ResolvedAgent.fields.agent,
        instructions: FactoryV4ResolvedAgent.fields.instructions,
        execution: FactoryV4ResolvedAgent.fields.execution,
        provenance: FactoryV4ResolvedAgent.fields.provenance,
      }),
    ),
    publish: Schema.optional(
      Schema.Struct({
        number: Schema.Int,
        url: Schema.String,
        commitSha: Schema.String,
        operationKey: Schema.String,
      }),
    ),
    execution: Schema.NullOr(FoundryWorkerExecution),
    artifacts: Schema.Array(FoundryArtifactManifest),
  }),
  Schema.Struct({ kind: Schema.Literal("definition"), version: FactoryDefinitionVersion }),
]);
export type AutomationApplicationResult = typeof AutomationApplicationResult.Type;
export class AutomationApplicationError extends Schema.TaggedError<AutomationApplicationError>()(
  "AutomationApplicationError",
  {
    code: Schema.Literals([
      "forbidden",
      "invalid_input",
      "conflict",
      "not_found",
      "unavailable",
      "writer_not_ended",
      "checkpoint_pending",
      "archive_missing",
      "workspace_changed",
      "unsupported_provider",
      "worker_not_ready",
      "invalid_execution",
    ]),
  },
) {
  override get message() {
    return `Factory operation failed (${this.code}).`;
  }
}
