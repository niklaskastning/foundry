import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import { FactoryV4Skill } from "./automation/definitionV4.ts";
import { ProjectId, ThreadId, EnvironmentId } from "./baseSchemas.ts";
import { FoundryInstanceId } from "./foundry.ts";
import {
  FoundrySandboxCleanupReceipt,
  FoundrySandboxSetupArchive,
  FoundrySandboxArchiveManifest,
} from "./foundrySandboxArchive.ts";
import { FoundryEnrollmentRequest, FoundryDeviceId } from "./foundryDevices.ts";

const Key = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/));
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
export const FoundrySandboxId = Schema.String.check(Schema.isUUID());
export const FoundrySandboxProfile = Schema.Struct({
  profileId: Key,
  revision: FoundrySandboxId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  image: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/)),
  architecture: Schema.Literals(["amd64", "arm64"]),
  resources: Schema.Struct({ cpuMillis: Positive, memoryMiB: Positive, pids: Positive }),
  lifetimeSeconds: Positive,
  maxLifetimeSeconds: Positive,
  network: Schema.Literals(["none", "configured"]),
  checkout: Schema.Struct({
    repository: Schema.String.check(
      Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+$/),
    ),
    commit: Sha,
  }),
  setup: Schema.Array(
    Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(64),
    ),
  ).check(Schema.isMaxLength(32)),
  tools: Schema.Array(
    Schema.Struct({ command: Key, version: Schema.String.check(Schema.isMaxLength(128)) }),
  ).check(Schema.isMaxLength(32)),
  providerConnectionId: Key,
  skills: Schema.optionalKey(Schema.Array(FactoryV4Skill).check(Schema.isMaxLength(32))),
  enabled: Schema.Boolean,
});
export type FoundrySandboxProfile = typeof FoundrySandboxProfile.Type;
export const FoundrySandboxProfileSummary = Schema.Struct({
  ...Struct.omit(FoundrySandboxProfile.fields, ["setup", "skills"]),
  setupStepCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(32),
  ),
});
export type FoundrySandboxProfileSummary = typeof FoundrySandboxProfileSummary.Type;

export const FoundrySandboxState = Schema.Literals([
  "requested",
  "provisioning",
  "setup",
  "ready",
  "draining",
  "stopped",
  "archiving",
  "deleting",
  "deleted",
  "failed",
]);
export type FoundrySandboxState = typeof FoundrySandboxState.Type;
export const FoundrySandboxOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interactive") }),
  Schema.Struct({
    kind: Schema.Literal("workflow"),
    factoryId: Schema.String.check(Schema.isMaxLength(128)),
    runId: Schema.String.check(Schema.isMaxLength(128)),
    attemptId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  }),
]);
export const FoundrySandboxRequest = Schema.Struct({
  commandId: Key,
  profileId: Key,
  revision: FoundrySandboxId,
  owner: FoundrySandboxOwner,
  resumeAllocationId: Schema.optionalKey(FoundrySandboxId),
  resumeThreadId: Schema.optionalKey(ThreadId),
});
export type FoundrySandboxRequest = typeof FoundrySandboxRequest.Type;
export const FoundrySandboxAllocation = Schema.Struct({
  allocationId: FoundrySandboxId,
  request: FoundrySandboxRequest,
  profile: FoundrySandboxProfile,
  state: FoundrySandboxState,
  generation: Positive,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  environmentId: Schema.NullOr(EnvironmentId),
  deviceId: Schema.NullOr(FoundryDeviceId),
  projectId: Schema.NullOr(ProjectId),
  failure: Schema.NullOr(
    Schema.Literals([
      "capacity",
      "provisioning",
      "checkout",
      "setup",
      "tools",
      "enrollment",
      "credentials",
      "archive",
      "unavailable",
    ]),
  ),
  deleteRequested: Schema.Boolean,
  failureFrom: Schema.NullOr(FoundrySandboxState),
  setupAdmitted: Schema.Boolean,
  runtimeAdmitted: Schema.Boolean,
});
export type FoundrySandboxAllocation = typeof FoundrySandboxAllocation.Type;
export const FoundrySandboxAllocationSummary = Schema.Struct({
  ...FoundrySandboxAllocation.fields,
  profile: FoundrySandboxProfileSummary,
});
export type FoundrySandboxAllocationSummary = typeof FoundrySandboxAllocationSummary.Type;

export class FoundrySandboxError extends Schema.TaggedError<FoundrySandboxError>()(
  "FoundrySandboxError",
  {
    code: Schema.Literals([
      "invalid_request",
      "forbidden",
      "not_found",
      "conflict",
      "capacity",
      "unavailable",
      "archive_required",
    ]),
  },
) {
  override get message(): string {
    return `Sandbox operation rejected (${this.code}).`;
  }
}
export const FoundrySandboxCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("get"), allocationId: FoundrySandboxId }),
  Schema.Struct({ action: Schema.Literal("request"), request: FoundrySandboxRequest }),
  Schema.Struct({
    action: Schema.Literals(["stop", "delete", "retry"]),
    allocationId: FoundrySandboxId,
  }),
  Schema.Struct({
    action: Schema.Literal("extend"),
    allocationId: FoundrySandboxId,
    expiresAt: Schema.Number,
  }),
]);
export type FoundrySandboxCommand = typeof FoundrySandboxCommand.Type;

export const FoundrySandboxMachineOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("setupProfile"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
  }),
  Schema.Struct({
    op: Schema.Literal("setupArchive"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    archive: FoundrySandboxSetupArchive,
    snapshotThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  }),
  Schema.Struct({
    op: Schema.Literal("enroll"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    enrollment: FoundryEnrollmentRequest,
  }),
  Schema.Struct({
    op: Schema.Literal("archive"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    manifests: Schema.Array(FoundrySandboxArchiveManifest).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(128),
    ),
    threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    op: Schema.Literal("resumeChunk"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    op: Schema.Literal("admitRuntime"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
  }),
  Schema.Struct({
    op: Schema.Literal("setupReport"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    log: Schema.String.check(Schema.isMaxLength(65536)),
  }),
  Schema.Struct({ op: Schema.Literal("claim"), leaseId: FoundrySandboxId }),
  Schema.Struct({
    op: Schema.Literal("transition"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    state: FoundrySandboxState,
    failure: FoundrySandboxAllocation.fields.failure,
  }),
  Schema.Struct({
    op: Schema.Literal("approve"),
    leaseId: FoundrySandboxId,
    allocationId: FoundrySandboxId,
    generation: Positive,
    environmentId: EnvironmentId,
    publicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  }),
]);
export type FoundrySandboxMachineOperation = typeof FoundrySandboxMachineOperation.Type;

export const FoundrySandboxMachineRequest = Schema.Struct({
  protocolVersion: Schema.Literal("sandbox-1"),
  instanceId: FoundryInstanceId,
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  generation: Positive,
  issuedAt: Schema.Number,
  request: FoundrySandboxMachineOperation,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundrySandboxMachineRequest = typeof FoundrySandboxMachineRequest.Type;

export const FoundrySandboxListResult = Schema.Struct({
  sandboxSupported: Schema.optionalKey(Schema.Boolean),
  profiles: Schema.Array(FoundrySandboxProfileSummary),
  allocations: Schema.Array(FoundrySandboxAllocationSummary),
});
export const FoundrySandboxDetail = Schema.Struct({
  allocation: FoundrySandboxAllocation,
  archiveReceipt: Schema.NullOr(FoundrySandboxCleanupReceipt),
  setupLog: Schema.String,
});
export const FoundrySandboxQuery = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("get"), allocationId: FoundrySandboxId }),
]);
export const FoundrySandboxMutation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("request"), request: FoundrySandboxRequest }),
  Schema.Struct({
    action: Schema.Literals(["stop", "delete", "retry"]),
    allocationId: FoundrySandboxId,
  }),
  Schema.Struct({
    action: Schema.Literal("extend"),
    allocationId: FoundrySandboxId,
    expiresAt: Schema.Number,
  }),
]);
