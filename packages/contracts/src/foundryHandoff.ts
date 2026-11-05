import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { FoundryArtifactManifest } from "./foundryArtifact.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";
import { FoundryArchiveOwner } from "./foundryArchive.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Report = Schema.String.check(Schema.isMaxLength(20_000));
export const FoundryHandoffMode = Schema.Literals(["existing", "branch", "archive"]);
export const FoundryWorkerHandoffOpen = Schema.Struct({
  commandId: CommandId,
  handoffId: Key,
  factoryId: Key,
  workItemId: Key,
  runId: Key,
  source: Schema.Struct({ commandId: CommandId, generation: NonNegativeInt }),
  projectId: ProjectId,
  mode: FoundryHandoffMode,
  archive: Schema.optional(
    Schema.Struct({
      bundle: FoundryArtifactManifest,
      commitSha: Sha,
      treeSha: Sha,
      sourceThreadId: ThreadId,
    }),
  ),
  title: Key,
});
export type FoundryWorkerHandoffOpen = typeof FoundryWorkerHandoffOpen.Type;
export const FoundryWorkerHandoffReceipt = Schema.Struct({
  handoffId: Key,
  threadId: ThreadId,
  projectId: ProjectId,
  workspacePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  baseCommit: Sha,
  baseCheckpointRef: Schema.String,
  sourceThreadId: ThreadId,
  mode: FoundryHandoffMode,
});
export type FoundryWorkerHandoffReceipt = typeof FoundryWorkerHandoffReceipt.Type;
export const FoundryWorkerHandoffFinish = Schema.Struct({
  commandId: CommandId,
  handoffId: Key,
  expectedBaseCommit: Sha,
  tests: Report,
  openPoints: Report,
});
export type FoundryWorkerHandoffFinish = typeof FoundryWorkerHandoffFinish.Type;
export const FoundryWorkerHandoffReopen = Schema.Struct({ commandId: CommandId, handoffId: Key });
export type FoundryWorkerHandoffReopen = typeof FoundryWorkerHandoffReopen.Type;
export const FoundryWorkerHandoffResult = Schema.Struct({
  receipt: FoundryWorkerHandoffReceipt,
  commitSha: Sha,
  treeSha: Sha,
  checkpointRef: Schema.String,
  bundle: FoundryArtifactManifest,
  archive: Schema.Struct({
    instanceId: FoundryInstanceId,
    deviceId: FoundryDeviceId,
    deviceGeneration: PositiveInt,
    owner: FoundryArchiveOwner,
    cursor: PositiveInt,
    sourceSequence: PositiveInt,
  }),
  tests: Report,
  openPoints: Report,
});
export type FoundryWorkerHandoffResult = typeof FoundryWorkerHandoffResult.Type;
export class FoundryWorkerHandoffError extends Schema.TaggedError<FoundryWorkerHandoffError>()(
  "FoundryWorkerHandoffError",
  {
    code: Schema.Literals([
      "not_enabled",
      "not_found",
      "conflict",
      "writer_not_ended",
      "checkpoint_pending",
      "archive_missing",
      "workspace_changed",
      "unavailable",
    ]),
  },
) {}
