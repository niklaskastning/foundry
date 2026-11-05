import {
  CommandId,
  RunId,
  CheckpointId,
  ProjectId,
  ThreadId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";
import { FoundryArchiveOwner } from "./foundryArchive.ts";
import { FoundryArtifactManifest } from "./foundryArtifact.ts";
import { FactoryV4ResolvedAgent, FactoryV4ResultSchema } from "./automation/definitionV4.ts";
import { FactoryMcpBinding } from "./automation/mcpBinding.ts";

export const FoundryWorkerDefinitionV4 = Schema.Struct({
  factoryId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  resources: FactoryV4ResolvedAgent,
  workspaceAccess: Schema.Literals(["read", "write"]),
  resultSchema: Schema.optional(FactoryV4ResultSchema),
  mcpBindings: Schema.Array(FactoryMcpBinding).check(Schema.isMaxLength(100)),
});
export type FoundryWorkerDefinitionV4 = typeof FoundryWorkerDefinitionV4.Type;

export const FoundryWorkerStatus = Schema.Struct({
  online: Schema.Literal(true),
  projectReady: Schema.optional(Schema.Boolean),
  roleExecutionVersion: Schema.optional(Schema.Literal(1)),
  parallelExecutionVersion: Schema.optional(Schema.Literal(1)),
  definitionExecutionVersion: Schema.optional(Schema.Literal(4)),
  capacity: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(8))),
  occupied: Schema.optional(Schema.NullOr(NonNegativeInt)),
  free: Schema.optional(Schema.NullOr(NonNegativeInt)),
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        aliases: Schema.Array(TrimmedNonEmptyString),
        reasoningEfforts: Schema.Array(TrimmedNonEmptyString),
      }),
    ),
  ),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerReady: Schema.Boolean,
  providerState: Schema.Literals([
    "unbound",
    "missing",
    "unsupported_provider",
    "disabled",
    "not_installed",
    "login_required",
    "auth_unknown",
    "version_unknown",
    "incompatible",
    "unavailable",
    "ready",
  ]),
  version: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
  capacityAvailable: Schema.NullOr(Schema.Boolean),
  activeRuns: Schema.NullOr(Schema.Number),
});
export type FoundryWorkerStatus = typeof FoundryWorkerStatus.Type;
export class FoundryWorkerError extends Schema.TaggedError<FoundryWorkerError>()(
  "FoundryWorkerError",
  { code: Schema.Literals(["not_enabled", "probe_failed"]) },
) {}

const PublishRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
const PublishSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const PublishCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export const FoundryPublishRequest = Schema.Struct({
  repository: PublishRepository,
  baseBranch: TrimmedNonEmptyString,
  checks: Schema.Array(PublishCheck).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export const FoundryPublishEvidence = Schema.Struct({
  sourceCwd: TrimmedNonEmptyString,
  repository: PublishRepository,
  baseBranch: TrimmedNonEmptyString,
  commitSha: PublishSha,
  treeSha: PublishSha,
  checks: Schema.Array(
    Schema.Struct({
      ...PublishCheck.fields,
      relativeCwd: TrimmedNonEmptyString,
      exitCode: Schema.Literal(0),
      commitSha: PublishSha,
      treeSha: PublishSha,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  bundle: FoundryArtifactManifest,
});
export type FoundryPublishEvidence = typeof FoundryPublishEvidence.Type;
export const FoundryWorkerLaunchInput = Schema.Struct({
  definitionV4: Schema.optional(FoundryWorkerDefinitionV4),
  previousHandoff: Schema.optional(
    Schema.Struct({
      handoffId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      commitSha: PublishSha,
    }),
  ),
  publishEvidence: Schema.optional(FoundryPublishRequest),
  inputArtifacts: Schema.optional(
    Schema.Array(FoundryArtifactManifest).check(Schema.isMaxLength(100)),
  ),
  workspaceMode: Schema.optional(Schema.Literals(["checkout", "worktree"])),
  workspaceRevision: Schema.optional(PublishSha),
  previousExecution: Schema.optional(
    Schema.Struct({ commandId: CommandId, generation: NonNegativeInt }),
  ),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  options: Schema.optional(
    Schema.Struct({
      reasoningEffort: Schema.optional(
        Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
      ),
    }),
  ),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type FoundryWorkerLaunchInput = typeof FoundryWorkerLaunchInput.Type;
export const FoundryWorkerLaunchReceipt = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  acceptedAt: IsoDateTime,
  sequence: NonNegativeInt,
});
export type FoundryWorkerLaunchReceipt = typeof FoundryWorkerLaunchReceipt.Type;
export class FoundryWorkerLaunchError extends Schema.TaggedError<FoundryWorkerLaunchError>()(
  "FoundryWorkerLaunchError",
  {
    code: Schema.Literals([
      "not_enabled",
      "project_denied",
      "provider_disabled",
      "provider_not_ready",
      "capacity_unavailable",
      "command_conflict",
      "launch_failed",
      "handoff_unavailable",
      "handoff_changed",
      "capability_denied",
      "resource_denied",
    ]),
  },
) {}

export const FoundryWorkerManifest = Schema.Struct({
  resourceFailure: Schema.optional(Schema.Literal("changed")),
  checkpointCommitSha: Schema.optional(PublishSha),
  structuredResult: Schema.optional(Schema.Json),
  structuredResultError: Schema.optional(Schema.Literals(["missing", "invalid", "oversized"])),
  workspacePath: Schema.optional(TrimmedNonEmptyString),
  publishEvidenceFailure: Schema.optional(
    Schema.Literals(["dirty_commit", "test_failed", "changed_commit", "unavailable"]),
  ),
  publishEvidence: Schema.optional(FoundryPublishEvidence),
  archive: Schema.optional(
    Schema.Struct({
      instanceId: FoundryInstanceId,
      deviceId: FoundryDeviceId,
      deviceGeneration: PositiveInt,
      owner: FoundryArchiveOwner,
      cursor: PositiveInt,
      sourceSequence: PositiveInt,
    }),
  ),
  generation: NonNegativeInt,
  runId: RunId,
  checkpointId: Schema.NullOr(CheckpointId),
  checkpointRef: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["completed", "stopped"]),
});
export type FoundryWorkerManifest = typeof FoundryWorkerManifest.Type;
export const FoundryWorkerLifecycle = Schema.Struct({
  generation: NonNegativeInt,
  expiresAt: Schema.Number,
  state: Schema.Literals(["active", "stopping", "uncertain", "finalizing", "completed", "stopped"]),
  writerEnded: Schema.Boolean,
  manifest: Schema.NullOr(FoundryWorkerManifest),
});
export const FoundryWorkerRenewInput = Schema.Struct({
  commandId: CommandId,
  generation: NonNegativeInt,
});
export type FoundryWorkerRenewInput = typeof FoundryWorkerRenewInput.Type;
export class FoundryWorkerRenewError extends Schema.TaggedError<FoundryWorkerRenewError>()(
  "FoundryWorkerRenewError",
  {
    code: Schema.Literals(["not_enabled", "stale_lease", "renew_failed"]),
  },
) {}
export const FoundryWorkerReadInput = Schema.Struct({ commandId: CommandId });
export type FoundryWorkerReadInput = typeof FoundryWorkerReadInput.Type;
export const FoundryWorkerExecution = Schema.Struct({
  lifecycle: Schema.optional(FoundryWorkerLifecycle),
  receipt: FoundryWorkerLaunchReceipt,
  // Run completion alone does not confirm checkpoint/manifest finalization.
  run: Schema.Struct({
    id: RunId,
    status: OrchestrationV2RunStatus,
    checkpointId: Schema.NullOr(CheckpointId),
  }),
});
export type FoundryWorkerExecution = typeof FoundryWorkerExecution.Type;
export class FoundryWorkerReadError extends Schema.TaggedError<FoundryWorkerReadError>()(
  "FoundryWorkerReadError",
  { code: Schema.Literals(["not_enabled", "not_found", "read_failed"]) },
) {}

export const FoundryWorkerFollowInput = Schema.Struct({
  commandId: CommandId,
  afterSequence: Schema.optional(NonNegativeInt),
});
export type FoundryWorkerFollowInput = typeof FoundryWorkerFollowInput.Type;
export const FoundryWorkerProgress = Schema.Struct({
  sequence: NonNegativeInt,
  execution: FoundryWorkerExecution,
});
export type FoundryWorkerProgress = typeof FoundryWorkerProgress.Type;
export class FoundryWorkerFollowError extends Schema.TaggedError<FoundryWorkerFollowError>()(
  "FoundryWorkerFollowError",
  { code: Schema.Literals(["not_enabled", "not_found", "invalid_cursor", "follow_failed"]) },
) {}

export const FoundryWorkerCancelInput = Schema.Struct({
  commandId: CommandId,
  launchCommandId: CommandId,
});
export type FoundryWorkerCancelInput = typeof FoundryWorkerCancelInput.Type;
const workerCancellationFields = {
  commandId: CommandId,
  launch: FoundryWorkerLaunchReceipt,
  runId: RunId,
};
export const FoundryWorkerCancellation = Schema.Union([
  Schema.Struct({
    commandId: CommandId,
    launchCommandId: CommandId,
    status: Schema.Literal("not_started"),
    noStartConfirmed: Schema.Literal(true),
  }),
  Schema.Struct({
    ...workerCancellationFields,
    status: Schema.Literal("requested"),
    sequence: NonNegativeInt,
  }),
  Schema.Struct({
    ...workerCancellationFields,
    status: Schema.Literal("already_terminal"),
    runStatus: Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  }),
]);
export type FoundryWorkerCancellation = typeof FoundryWorkerCancellation.Type;
export class FoundryWorkerCancelError extends Schema.TaggedError<FoundryWorkerCancelError>()(
  "FoundryWorkerCancelError",
  {
    code: Schema.Literals([
      "not_enabled",
      "not_found",
      "command_conflict",
      "not_interruptible",
      "cancel_failed",
    ]),
  },
) {}
