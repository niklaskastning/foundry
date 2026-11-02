import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const ASSET_TRANSFER_CHUNK_BYTES = 32 * 1024;
export const ASSET_TRANSFER_MAX_BYTES = 16 * 1024 * 1024;
const Url = Schema.String.check(Schema.isMaxLength(4096));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Offset = NonNegativeInt.check(Schema.isLessThanOrEqualTo(ASSET_TRANSFER_MAX_BYTES));
const Bytes = Schema.String.check(
  Schema.isMaxLength(4 * Math.ceil(ASSET_TRANSFER_CHUNK_BYTES / 3)),
);
export const AssetReadChunkInput = Schema.Struct({
  url: Url,
  offset: Offset,
  revision: Schema.optional(Digest),
});
export type AssetReadChunkInput = typeof AssetReadChunkInput.Type;
export const AssetReadChunkResult = Schema.Struct({
  offset: Offset,
  total: Offset,
  revision: Digest,
  sha256: Digest,
  data: Bytes,
});
export type AssetReadChunkResult = typeof AssetReadChunkResult.Type;
export const AttachmentChunkStatusInput = Schema.Struct({ url: Url });
export type AttachmentChunkStatusInput = typeof AttachmentChunkStatusInput.Type;
export const AttachmentChunkStatus = Schema.Struct({
  offset: Offset,
  complete: Schema.Boolean,
  fileSha256: Schema.NullOr(Digest),
});
export type AttachmentChunkStatus = typeof AttachmentChunkStatus.Type;
export const AttachmentWriteChunkInput = Schema.Struct({
  url: Url,
  offset: Offset,
  data: Bytes,
  sha256: Digest,
  fileSha256: Digest,
});
export type AttachmentWriteChunkInput = typeof AttachmentWriteChunkInput.Type;
export class AssetTransferError extends Schema.TaggedError<AssetTransferError>()(
  "AssetTransferError",
  {
    code: Schema.Literals(["invalid_request", "forbidden", "changed", "capacity", "unavailable"]),
  },
) {
  override get message(): string {
    return `Asset transfer rejected (${this.code}).`;
  }
}
