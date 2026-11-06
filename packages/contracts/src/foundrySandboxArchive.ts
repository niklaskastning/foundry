import * as Schema from "effect/Schema";
import { PositiveInt } from "./baseSchemas.ts";
import { FoundryArchiveOwner } from "./foundryArchive.ts";
import { FoundryArtifactManifest } from "./foundryArtifact.ts";

const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const FoundrySandboxArchiveManifest = Schema.Struct({
  allocationId: Schema.String.check(Schema.isUUID()),
  fence: PositiveInt,
  owner: FoundryArchiveOwner,
  relativeWorkspacePath: Schema.String.check(
    Schema.isPattern(/^(?!.*\/\.)(?!.*\/\/)[a-zA-Z0-9][a-zA-Z0-9_./-]{0,511}$/),
  ),
  finalCursor: PositiveInt,
  finalSourceSequence: PositiveInt,
  headCommit: Commit,
  checkpointCommit: Commit,
  checkpointTree: Commit,
  bundle: FoundryArtifactManifest,
});
export type FoundrySandboxArchiveManifest = typeof FoundrySandboxArchiveManifest.Type;
export const FoundrySandboxArchiveReceipt = Schema.Struct({
  manifest: FoundrySandboxArchiveManifest,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type FoundrySandboxArchiveReceipt = typeof FoundrySandboxArchiveReceipt.Type;
export class FoundrySandboxArchiveError extends Schema.TaggedError<FoundrySandboxArchiveError>()(
  "FoundrySandboxArchiveError",
  {
    code: Schema.Literals([
      "invalid_request",
      "incomplete",
      "changed",
      "foreign_archive",
      "destination_not_empty",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Sandbox archive operation failed (${this.code}).`;
  }
}

const CleanupIdentity = {
  allocationId: FoundrySandboxArchiveManifest.fields.allocationId,
  fence: PositiveInt,
};
export const FOUNDRY_SETUP_PART_BYTES = 8 * 1024 * 1024;
export const FOUNDRY_SETUP_MAX_PARTS = 1024;
const SetupPartMetadata = Schema.Struct({
  sizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(FOUNDRY_SETUP_PART_BYTES)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const FoundrySandboxSetupLocalIndex = Schema.Struct({
  format: Schema.Literal("foundry-setup-local-2"),
  parts: Schema.Array(SetupPartMetadata).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FOUNDRY_SETUP_MAX_PARTS),
  ),
});
export const FoundrySandboxSetupIndex = Schema.Struct({
  format: Schema.Literal("foundry-setup-snapshot-2"),
  parts: Schema.Array(FoundryArtifactManifest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FOUNDRY_SETUP_MAX_PARTS),
  ),
});

export const FoundrySandboxSetupArchive = Schema.Union([
  Schema.Struct({
    ...CleanupIdentity,
    kind: Schema.Literal("setup"),
    artifact: FoundryArtifactManifest,
  }),
  Schema.Struct({ ...CleanupIdentity, kind: Schema.Literal("empty") }),
]);
export type FoundrySandboxSetupArchive = typeof FoundrySandboxSetupArchive.Type;
export const FoundrySandboxSetupReceipt = Schema.Struct({
  archive: FoundrySandboxSetupArchive,
  digest: FoundrySandboxArchiveReceipt.fields.digest,
});
export type FoundrySandboxSetupReceipt = typeof FoundrySandboxSetupReceipt.Type;
export const FoundrySandboxEnvironmentReceipt = Schema.Struct({
  ...CleanupIdentity,
  kind: Schema.Literal("environment"),
  threads: Schema.Array(FoundrySandboxArchiveReceipt).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  digest: FoundrySandboxArchiveReceipt.fields.digest,
});
export type FoundrySandboxEnvironmentReceipt = typeof FoundrySandboxEnvironmentReceipt.Type;
export const FoundrySandboxCleanupReceipt = Schema.Union([
  FoundrySandboxEnvironmentReceipt,
  FoundrySandboxSetupReceipt,
]);
export type FoundrySandboxCleanupReceipt = typeof FoundrySandboxCleanupReceipt.Type;
