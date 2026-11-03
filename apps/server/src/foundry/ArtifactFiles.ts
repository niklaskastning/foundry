// @effect-diagnostics nodeBuiltinImport:off -- Durable positional writes, directory fsync and streaming hashes form this filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  FoundryArtifactError,
  FoundryArtifactId,
  FOUNDRY_ARTIFACT_MAX_BYTES,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ArtifactDirectory extends Context.Service<
  ArtifactDirectory,
  { readonly path: string }
>()("t3/foundry/ArtifactFiles/ArtifactDirectory") {}
export class ArtifactFiles extends Context.Service<
  ArtifactFiles,
  {
    readonly write: (
      id: FoundryArtifactId,
      offset: number,
      bytes: Uint8Array,
    ) => Effect.Effect<void, FoundryArtifactError>;
    readonly read: (
      id: FoundryArtifactId,
      offset: number,
      length: number,
      published: boolean,
    ) => Effect.Effect<Uint8Array, FoundryArtifactError>;
    readonly publish: (
      id: FoundryArtifactId,
      size: number,
      sha256: string,
    ) => Effect.Effect<void, FoundryArtifactError>;
    readonly abort: (id: FoundryArtifactId) => Effect.Effect<void, FoundryArtifactError>;
  }
>()("t3/foundry/ArtifactFiles") {}

const { constants } = NodeFS;
const isId = Schema.is(FoundryArtifactId);
const isArtifactError = Schema.is(FoundryArtifactError);
const fileError = (error: unknown) =>
  isArtifactError(error)
    ? error
    : new FoundryArtifactError({
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOSPC" || error.code === "EDQUOT")
            ? "capacity"
            : "unavailable",
      });
const syncDirectory = async (path: string) => {
  const handle = await NodeFSP.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const make = Effect.gen(function* () {
  const directory = yield* ArtifactDirectory;
  const root = NodePath.resolve(directory.path);
  const pending = NodePath.join(root, "pending");
  const blobs = NodePath.join(root, "blobs");
  yield* Effect.tryPromise({
    try: async () => {
      const parent = NodePath.dirname(root);
      if ((await NodeFSP.realpath(parent)) !== parent)
        throw new FoundryArtifactError({ code: "unavailable" });
      for (const path of [root, pending, blobs]) {
        try {
          await NodeFSP.mkdir(path, { mode: 0o700 });
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
        const info = await NodeFSP.lstat(path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          (await NodeFSP.realpath(path)) !== path
        )
          throw new FoundryArtifactError({ code: "unavailable" });
        await syncDirectory(path);
      }
      await syncDirectory(root);
      await syncDirectory(parent);
    },
    catch: fileError,
  });
  const paths = (id: FoundryArtifactId) => {
    if (!isId(id)) throw new FoundryArtifactError({ code: "invalid_request" });
    return { pending: NodePath.join(pending, `${id}.part`), final: NodePath.join(blobs, id) };
  };
  const open = async (path: string, flags: number) => {
    const handle = await NodeFSP.open(path, flags | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > FOUNDRY_ARTIFACT_MAX_BYTES) {
      await handle.close();
      throw new FoundryArtifactError({ code: "changed" });
    }
    return handle;
  };
  const exists = async (path: string) => {
    try {
      await NodeFSP.lstat(path);
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  };
  const verify = async (path: string, size: number, sha256: string) => {
    const handle = await open(path, constants.O_RDONLY);
    try {
      const before = await handle.stat({ bigint: true });
      if (before.size !== BigInt(size)) throw new FoundryArtifactError({ code: "incomplete" });
      const hash = NodeCrypto.createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 }))
        hash.update(chunk);
      const after = await handle.stat({ bigint: true });
      if (
        hash.digest("hex") !== sha256 ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new FoundryArtifactError({ code: "changed" });
    } finally {
      await handle.close();
    }
  };
  return ArtifactFiles.of({
    write: Effect.fn("ArtifactFiles.write")((id, offset, bytes) =>
      Effect.tryPromise({
        try: async () => {
          const file = paths(id);
          if (await exists(file.final)) throw new FoundryArtifactError({ code: "changed" });
          const handle = await open(file.pending, constants.O_RDWR | constants.O_CREAT);
          try {
            if ((await handle.stat()).size < offset)
              throw new FoundryArtifactError({ code: "incomplete" });
            await handle.truncate(offset);
            let written = 0;
            while (written < bytes.byteLength) {
              const result = await handle.write(
                bytes,
                written,
                bytes.byteLength - written,
                offset + written,
              );
              if (result.bytesWritten === 0)
                throw new FoundryArtifactError({ code: "unavailable" });
              written += result.bytesWritten;
            }
            await handle.sync();
            await syncDirectory(pending);
          } finally {
            await handle.close();
          }
        },
        catch: fileError,
      }),
    ),
    read: Effect.fn("ArtifactFiles.read")((id, offset, length, published) =>
      Effect.tryPromise({
        try: async () => {
          const file = paths(id);
          const path = published || !(await exists(file.pending)) ? file.final : file.pending;
          const handle = await open(path, constants.O_RDONLY);
          try {
            const bytes = new Uint8Array(length);
            let count = 0;
            while (count < bytes.length) {
              const result = await handle.read(bytes, count, bytes.length - count, offset + count);
              if (!result.bytesRead) throw new FoundryArtifactError({ code: "incomplete" });
              count += result.bytesRead;
            }
            return bytes;
          } finally {
            await handle.close();
          }
        },
        catch: fileError,
      }),
    ),
    publish: Effect.fn("ArtifactFiles.publish")((id, size, sha256) =>
      Effect.tryPromise({
        try: async () => {
          const file = paths(id);
          if (size === 0 && !(await exists(file.pending)) && !(await exists(file.final))) {
            const handle = await open(
              file.pending,
              constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
            );
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          if (await exists(file.final)) await verify(file.final, size, sha256);
          else {
            await verify(file.pending, size, sha256);
            await NodeFSP.rename(file.pending, file.final);
          }
          await syncDirectory(blobs);
          await syncDirectory(pending);
        },
        catch: fileError,
      }),
    ),
    abort: Effect.fn("ArtifactFiles.abort")((id) =>
      Effect.tryPromise({
        try: async () => {
          const file = paths(id);
          await NodeFSP.rm(file.pending, { force: true });
          await NodeFSP.rm(file.final, { force: true });
          await syncDirectory(pending);
          await syncDirectory(blobs);
        },
        catch: fileError,
      }),
    ),
  });
});
export const layer = Layer.effect(ArtifactFiles, make);
