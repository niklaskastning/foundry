import {
  ASSET_TRANSFER_CHUNK_BYTES,
  ASSET_TRANSFER_MAX_BYTES,
  AssetTransferError,
  type AssetReadChunkInput,
  type AssetReadChunkResult,
  type AttachmentChunkStatus,
  type AttachmentWriteChunkInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";

export const withFoundryReadLimit = Effect.fn("assets.withFoundryReadLimit")(function* <
  T extends { readonly maxBytes?: number | undefined },
>(input: T) {
  const supervisor = yield* EnvironmentSupervisor;
  return supervisor.target._tag === "FoundryConnectionTarget"
    ? { ...input, maxBytes: Math.min(input.maxBytes ?? 16 * 1024, 16 * 1024) }
    : input;
});

const invalid = () => new AssetTransferError({ code: "changed" });

export async function assetDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encode(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += ASSET_TRANSFER_CHUNK_BYTES) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + ASSET_TRANSFER_CHUNK_BYTES));
  }
  return btoa(result);
}

export const readAssetChunks = Effect.fn("assets.readChunks")(function* <E, R>(
  url: string,
  read: (input: AssetReadChunkInput) => Effect.Effect<AssetReadChunkResult, E, R>,
) {
  let offset = 0;
  let revision: string | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  do {
    const chunk = yield* read({ url, offset, ...(revision ? { revision } : {}) });
    if (
      chunk.offset !== offset ||
      chunk.total > ASSET_TRANSFER_MAX_BYTES ||
      chunk.total < offset ||
      (revision !== undefined && (chunk.revision !== revision || chunk.total !== bytes?.length))
    )
      return yield* invalid();
    const part = yield* Effect.try({
      try: () => Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0)),
      catch: invalid,
    });
    if (
      encode(part) !== chunk.data ||
      part.length > ASSET_TRANSFER_CHUNK_BYTES ||
      part.length !== Math.min(ASSET_TRANSFER_CHUNK_BYTES, chunk.total - offset) ||
      (yield* Effect.tryPromise({ try: () => assetDigest(part), catch: invalid })) !== chunk.sha256
    )
      return yield* invalid();
    bytes ??= new Uint8Array(chunk.total);
    revision = chunk.revision;
    bytes.set(part, offset);
    offset += part.length;
  } while (offset < bytes.length);
  return bytes;
});

export async function writeAttachmentChunks(input: {
  readonly url: string;
  readonly file: Blob;
  readonly signal: AbortSignal;
  readonly status: () => Promise<AttachmentChunkStatus>;
  readonly write: (chunk: AttachmentWriteChunkInput) => Promise<AttachmentChunkStatus>;
  readonly onProgress: (progress: number) => void;
}): Promise<void> {
  input.signal.throwIfAborted();
  if (input.file.size < 1 || input.file.size > ASSET_TRANSFER_MAX_BYTES) {
    throw new AssetTransferError({ code: "capacity" });
  }
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const fileSha256 = await assetDigest(bytes);
  input.signal.throwIfAborted();
  let status = await input.status();
  if (
    status.offset > bytes.length ||
    (status.fileSha256 !== null && status.fileSha256 !== fileSha256) ||
    (status.offset > 0 && status.fileSha256 === null) ||
    (status.complete && status.offset !== bytes.length)
  )
    throw invalid();
  // A lost final reply can leave all bytes staged but publication unfinished; replay the final chunk.
  let offset =
    status.offset === bytes.length && !status.complete
      ? Math.floor((bytes.length - 1) / ASSET_TRANSFER_CHUNK_BYTES) * ASSET_TRANSFER_CHUNK_BYTES
      : status.offset;
  while (!status.complete) {
    input.signal.throwIfAborted();
    const part = bytes.slice(offset, offset + ASSET_TRANSFER_CHUNK_BYTES);
    const sha256 = await assetDigest(part);
    input.signal.throwIfAborted();
    status = await input.write({ url: input.url, offset, data: encode(part), sha256, fileSha256 });
    if (
      status.offset !== offset + part.length ||
      status.fileSha256 !== fileSha256 ||
      status.complete !== (status.offset === bytes.length)
    )
      throw invalid();
    offset = status.offset;
    input.onProgress(offset / bytes.length);
  }
  input.signal.throwIfAborted();
  input.onProgress(1);
}

export function materializeAsset(bytes: Uint8Array<ArrayBuffer>, signedPath: string) {
  const extension = signedPath.slice(signedPath.lastIndexOf(".")).toLowerCase();
  // Data URLs have opaque origins even when opened outside the sandboxed preview frame.
  if (extension === ".svg" || extension === ".html" || extension === ".htm") {
    const type = extension === ".svg" ? "image/svg+xml" : "text/plain";
    return { url: `data:${type};base64,${encode(bytes)}`, dispose: () => {} };
  }
  const types: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  };
  const url = URL.createObjectURL(
    new Blob([bytes], { type: types[extension] ?? "application/octet-stream" }),
  );
  return { url, dispose: () => URL.revokeObjectURL(url) };
}
