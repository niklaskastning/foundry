// @effect-diagnostics nodeBuiltinImport:off -- Positional reads and chunk hashes preserve bounded binary transfer semantics.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import {
  ASSET_TRANSFER_CHUNK_BYTES,
  ASSET_TRANSFER_MAX_BYTES,
  AssetReadChunkInput,
  type AssetReadChunkResult,
  AttachmentWriteChunkInput,
  AttachmentChunkStatusInput,
  type AttachmentChunkStatus,
  AssetTransferError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { resolveAsset } from "./AssetAccess.ts";
import { openMediaFile } from "./MediaFile.ts";
import {
  validateAttachmentUploadToken,
  storeAttachmentUpload,
  deletePendingAttachment,
} from "./AttachmentUpload.ts";

export class AssetTransfer extends Context.Service<
  AssetTransfer,
  {
    readonly read: (
      input: AssetReadChunkInput,
    ) => Effect.Effect<AssetReadChunkResult, AssetTransferError>;
    readonly write: (
      input: AttachmentWriteChunkInput,
    ) => Effect.Effect<AttachmentChunkStatus, AssetTransferError>;
    readonly status: (
      input: AttachmentChunkStatusInput,
    ) => Effect.Effect<AttachmentChunkStatus, AssetTransferError>;
    readonly remove: (attachmentId: string) => Effect.Effect<void>;
  }
>()("t3/assets/AssetTransfer") {}

const decodeRead = Schema.decodeEffect(AssetReadChunkInput);
const decodeWrite = Schema.decodeEffect(AttachmentWriteChunkInput);
const isTransferError = Schema.is(AssetTransferError);

const fail = (code: AssetTransferError["code"]) => new AssetTransferError({ code });
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const revision = (info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) => digest(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
const parseUrl = (url: string, prefix: string) => {
  if (
    !url.startsWith(prefix) ||
    url.includes("?") ||
    url.includes("#") ||
    url.includes("\\") ||
    url.length > 4096
  )
    throw fail("invalid_request");
  const value = url.slice(prefix.length);
  if (
    !value ||
    /%(?:2e|2f|5c)/i.test(value) ||
    value.split("/").some((s) => s === "." || s === "..")
  )
    throw fail("invalid_request");
  return value;
};

const make = Effect.gen(function* () {
  const dependencies =
    yield* Effect.context<
      Exclude<
        Effect.Services<
          | ReturnType<typeof resolveAsset>
          | ReturnType<typeof storeAttachmentUpload>
          | ReturnType<typeof validateAttachmentUploadToken>
        >,
        Scope.Scope
      >
    >();
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-asset-chunks-" });
  const lock = yield* Semaphore.make(1);
  const reads = yield* Semaphore.make(4);
  const writes = yield* Semaphore.make(4);
  const uploads = new Map<
    string,
    {
      path: string;
      attachmentId: string;
      size: number;
      expiresAt: number;
      offset: number;
      complete: boolean;
      fileSha256: string;
    }
  >();
  const sweep = Effect.fn("AssetTransfer.sweep")(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [key, state] of uploads)
      if (state.expiresAt <= now) {
        yield* fs.remove(state.path, { force: true }).pipe(Effect.orDie);
        uploads.delete(key);
      }
  });
  const claimsFor = Effect.fn("AssetTransfer.claims")(function* (url: string) {
    const token = yield* Effect.try({
      try: () => parseUrl(url, "/api/attachments/upload/"),
      catch: () => fail("invalid_request"),
    });
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) return yield* fail("forbidden");
    if (claims.sizeBytes < 1 || claims.sizeBytes > ASSET_TRANSFER_MAX_BYTES)
      return yield* fail("capacity");
    return claims;
  });
  const read = Effect.fn("AssetTransfer.read")(
    function* (input: AssetReadChunkInput) {
      yield* decodeRead(input).pipe(Effect.mapError(() => fail("invalid_request")));
      const suffix = yield* Effect.try({
        try: () => parseUrl(input.url, "/api/assets/"),
        catch: () => fail("invalid_request"),
      });
      const slash = suffix.indexOf("/");
      if (slash <= 0) return yield* fail("invalid_request");
      const asset = yield* resolveAsset(suffix.slice(0, slash), suffix.slice(slash + 1));
      if (!asset || asset.kind === "source-control-media") return yield* fail("forbidden");
      let bytes: Uint8Array;
      let total: number;
      let version: string;
      if (asset.kind === "bytes") {
        total = asset.bytes.length;
        if (total > ASSET_TRANSFER_MAX_BYTES) return yield* fail("capacity");
        version = digest(asset.bytes);
        bytes = asset.bytes.subarray(input.offset, input.offset + ASSET_TRANSFER_CHUNK_BYTES);
      } else {
        const file =
          ("file" in asset ? asset.file : undefined) ?? (yield* openMediaFile(asset.path));
        if (!file) return yield* fail("forbidden");
        total = Number(file.info.size);
        if (total > ASSET_TRANSFER_MAX_BYTES) return yield* fail("capacity");
        version = revision(file.info);
        if (
          input.offset > total ||
          (input.offset > 0 && input.revision === undefined) ||
          (input.revision !== undefined && input.revision !== version)
        )
          return yield* fail("changed");
        bytes = new Uint8Array(Math.min(ASSET_TRANSFER_CHUNK_BYTES, total - input.offset));
        const received = yield* Effect.tryPromise(async () => {
          let offset = 0;
          while (offset < bytes.length) {
            const result = await file.handle.read(
              bytes,
              offset,
              bytes.length - offset,
              input.offset + offset,
            );
            if (!result.bytesRead) break;
            offset += result.bytesRead;
          }
          return offset;
        });
        const after = yield* Effect.tryPromise(() => file.handle.stat({ bigint: true }));
        if (received !== bytes.length || revision(after) !== version) return yield* fail("changed");
      }
      if (
        input.offset > total ||
        (input.offset > 0 && input.revision === undefined) ||
        (input.revision !== undefined && input.revision !== version)
      )
        return yield* fail("changed");
      return {
        offset: input.offset,
        total,
        revision: version,
        sha256: digest(bytes),
        data: Buffer.from(bytes).toString("base64"),
      };
    },
    Effect.scoped,
    reads.withPermitsIfAvailable(1),
    Effect.flatMap((value) => Effect.fromOption(value, () => fail("capacity"))),
    Effect.provide(dependencies),
    Effect.mapError((error) => (isTransferError(error) ? error : fail("unavailable"))),
  );
  const status = Effect.fn("AssetTransfer.status")(
    function* (input: AttachmentChunkStatusInput) {
      yield* sweep();
      yield* claimsFor(input.url);
      const state = uploads.get(digest(input.url));
      return state
        ? { offset: state.offset, complete: state.complete, fileSha256: state.fileSha256 }
        : { offset: 0, complete: false, fileSha256: null };
    },
    lock.withPermit,
    Effect.provide(dependencies),
    Effect.mapError((error) => (isTransferError(error) ? error : fail("unavailable"))),
  );
  const write = Effect.fn("AssetTransfer.write")(
    function* (input: AttachmentWriteChunkInput) {
      yield* decodeWrite(input).pipe(Effect.mapError(() => fail("invalid_request")));
      yield* sweep();
      const claims = yield* claimsFor(input.url);
      const bytes = Buffer.from(input.data, "base64");
      if (
        bytes.length < 1 ||
        bytes.length > ASSET_TRANSFER_CHUNK_BYTES ||
        bytes.toString("base64") !== input.data ||
        digest(bytes) !== input.sha256 ||
        input.offset + bytes.length > claims.sizeBytes
      )
        return yield* fail("invalid_request");
      const key = digest(input.url);
      let state = uploads.get(key);
      if (!state) {
        if (input.offset !== 0) return yield* fail("changed");
        const reserved = [...uploads.values()].reduce((n, u) => n + u.size, 0);
        if (uploads.size >= 32 || reserved + claims.sizeBytes > 64 * 1024 * 1024)
          return yield* fail("capacity");
        state = {
          path: `${directory}/${key}`,
          attachmentId: claims.attachmentId,
          size: claims.sizeBytes,
          expiresAt: claims.expiresAt,
          offset: 0,
          complete: false,
          fileSha256: input.fileSha256,
        };
        const created = state;
        yield* fs.writeFile(created.path, new Uint8Array(), { mode: 0o600 }).pipe(
          Effect.tap(() => Effect.sync(() => uploads.set(key, created))),
          Effect.uninterruptible,
        );
      }
      if (state.fileSha256 !== input.fileSha256 || input.offset > state.offset)
        return yield* fail("changed");
      if (input.offset < state.offset) {
        if (input.offset + bytes.length > state.offset) return yield* fail("changed");
        const previousPath = state.path;
        const previous = yield* Effect.acquireUseRelease(
          Effect.tryPromise(() => NodeFSP.open(previousPath, "r")),
          (handle) =>
            Effect.tryPromise(async () => {
              const buffer = Buffer.alloc(bytes.length);
              const result = await handle.read(buffer, 0, buffer.length, input.offset);
              return result.bytesRead === bytes.length && buffer.equals(bytes);
            }),
          (handle) => Effect.promise(() => handle.close()),
        );
        if (!previous) return yield* fail("changed");
      } else {
        if (state.complete) return yield* fail("changed");
        const confirmed = state;
        yield* Effect.acquireUseRelease(
          Effect.tryPromise(() => NodeFSP.open(confirmed.path, "r+")),
          (handle) =>
            Effect.tryPromise(async () => {
              await handle.truncate(confirmed.offset);
              let written = 0;
              while (written < bytes.length) {
                const result = await handle.write(
                  bytes,
                  written,
                  bytes.length - written,
                  confirmed.offset + written,
                );
                if (!result.bytesWritten) throw new Error("No write progress");
                written += result.bytesWritten;
              }
              confirmed.offset += written;
            }),
          (handle) => Effect.promise(() => handle.close()),
        ).pipe(Effect.uninterruptible);
      }
      if (state.offset === state.size && !state.complete) {
        const hash = yield* fs.stream(state.path).pipe(
          Stream.runFold(
            () => NodeCrypto.createHash("sha256"),
            (h, part) => h.update(part),
          ),
          Effect.map((h) => h.digest("hex")),
        );
        if (hash !== state.fileSha256) return yield* fail("changed");
        const result = yield* storeAttachmentUpload(claims, fs.stream(state.path));
        if (!result.ok) return yield* fail(result.status === 409 ? "changed" : "unavailable");
        state.complete = true;
      }
      return { offset: state.offset, complete: state.complete, fileSha256: state.fileSha256 };
    },
    lock.withPermit,
    writes.withPermitsIfAvailable(1),
    Effect.flatMap((value) => Effect.fromOption(value, () => fail("capacity"))),
    Effect.provide(dependencies),
    Effect.mapError((error) => (isTransferError(error) ? error : fail("unavailable"))),
  );
  const remove = Effect.fn("AssetTransfer.remove")(
    function* (attachmentId: string) {
      for (const [key, state] of uploads)
        if (state.attachmentId === attachmentId) {
          yield* fs.remove(state.path, { force: true }).pipe(Effect.orDie);
          uploads.delete(key);
        }
      yield* deletePendingAttachment(attachmentId);
    },
    lock.withPermit,
    Effect.provide(dependencies),
  );
  return AssetTransfer.of({ read, write, status, remove });
});
export const layer = Layer.effect(AssetTransfer, make);
