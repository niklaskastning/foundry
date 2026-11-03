import * as Schema from "effect/Schema";
import { CommandId, EnvironmentId, ThreadId, NonNegativeInt } from "./baseSchemas.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";

export const FOUNDRY_ARTIFACT_CHUNK_BYTES = 256 * 1024;
export const FOUNDRY_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
export const FoundryArtifactId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("FoundryArtifactId"),
);
export type FoundryArtifactId = typeof FoundryArtifactId.Type;
export const FoundryArtifactOwner = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type FoundryArtifactOwner = typeof FoundryArtifactOwner.Type;
export const FoundryArtifactReference = Schema.Struct({
  instanceId: FoundryInstanceId,
  artifactId: FoundryArtifactId,
  owner: FoundryArtifactOwner,
});
export type FoundryArtifactReference = typeof FoundryArtifactReference.Type;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Size = NonNegativeInt.check(Schema.isLessThanOrEqualTo(FOUNDRY_ARTIFACT_MAX_BYTES));
const FileFields = {
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mimeType: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  ),
  sizeBytes: Size,
  sha256: Digest,
};
export const FoundryArtifactManifest = Schema.Struct({
  reference: FoundryArtifactReference,
  ...FileFields,
});
export type FoundryArtifactManifest = typeof FoundryArtifactManifest.Type;
export const FoundryArtifactBegin = Schema.Struct({
  instanceId: FoundryInstanceId,
  commandId: CommandId,
  owner: FoundryArtifactOwner,
  ...FileFields,
});
export type FoundryArtifactBegin = typeof FoundryArtifactBegin.Type;
export const FoundryArtifactStatus = Schema.Struct({
  reference: FoundryArtifactReference,
  state: Schema.Literals(["uploading", "published", "aborted"]),
  offset: Size,
  sizeBytes: Size,
  sha256: Digest,
});
export type FoundryArtifactStatus = typeof FoundryArtifactStatus.Type;
export const FoundryArtifactWrite = Schema.Struct({
  reference: FoundryArtifactReference,
  offset: Size,
  sha256: Digest,
  data: Schema.String.check(Schema.isMaxLength(4 * Math.ceil(FOUNDRY_ARTIFACT_CHUNK_BYTES / 3))),
});
export type FoundryArtifactWrite = typeof FoundryArtifactWrite.Type;
export const FoundryArtifactRead = Schema.Struct({
  reference: FoundryArtifactReference,
  offset: Size,
});
export type FoundryArtifactRead = typeof FoundryArtifactRead.Type;
export const FoundryArtifactChunk = Schema.Struct({
  offset: Size,
  total: Size,
  fileSha256: Digest,
  sha256: Digest,
  data: Schema.String.check(Schema.isMaxLength(4 * Math.ceil(FOUNDRY_ARTIFACT_CHUNK_BYTES / 3))),
});
export type FoundryArtifactChunk = typeof FoundryArtifactChunk.Type;
export const FoundryArtifactList = Schema.Struct({
  before: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[1-9][0-9]{0,18}$/),
      Schema.makeFilter((value) => value.length < 19 || value <= "9223372036854775807"),
    ),
  ),
  owner: Schema.optional(FoundryArtifactOwner),
});
export type FoundryArtifactList = typeof FoundryArtifactList.Type;
export const FoundryArtifactPage = Schema.Struct({
  items: Schema.Array(FoundryArtifactManifest),
  nextCursor: Schema.NullOr(Schema.String),
});
export type FoundryArtifactPage = typeof FoundryArtifactPage.Type;
export const FoundryArtifactRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("begin"), input: FoundryArtifactBegin }),
  Schema.Struct({ op: Schema.Literal("write"), input: FoundryArtifactWrite }),
  Schema.Struct({ op: Schema.Literal("read"), input: FoundryArtifactRead }),
  Schema.Struct({ op: Schema.Literal("list"), input: FoundryArtifactList }),
  Schema.Struct({
    op: Schema.Literals(["status", "publish", "abort", "metadata"]),
    input: FoundryArtifactReference,
  }),
]);
export type FoundryArtifactRequest = typeof FoundryArtifactRequest.Type;
export const FoundryArtifactMachineRequest = Schema.Struct({
  protocolVersion: Schema.Literal("1"),
  instanceId: FoundryInstanceId,
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  issuedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  request: FoundryArtifactRequest,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundryArtifactMachineRequest = typeof FoundryArtifactMachineRequest.Type;
export class FoundryArtifactError extends Schema.TaggedError<FoundryArtifactError>()(
  "FoundryArtifactError",
  {
    code: Schema.Literals([
      "invalid_request",
      "forbidden",
      "command_conflict",
      "changed",
      "incomplete",
      "capacity",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Foundry artifact operation failed (${this.code}).`;
  }
}
