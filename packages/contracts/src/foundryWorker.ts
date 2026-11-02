import {
  CommandId,
  RunId,
  CheckpointId,
  ProjectId,
  ThreadId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FoundryWorkerStatus = Schema.Struct({
  online: Schema.Literal(true),
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

export const FoundryWorkerLaunchInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
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
      "command_conflict",
      "launch_failed",
    ]),
  },
) {}

export const FoundryWorkerManifest = Schema.Struct({
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
