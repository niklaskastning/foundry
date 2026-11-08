// @effect-diagnostics nodeBuiltinImport:off -- Stream bounded Git bundle parts and hashes without loading repository history into memory.
import * as NodeCrypto from "node:crypto";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE,
  FOUNDRY_SANDBOX_BUNDLE_PART_BYTES,
  FOUNDRY_SANDBOX_BUNDLE_MAX_PARTS,
  FOUNDRY_SANDBOX_BUNDLE_MAX_BYTES,
  FoundrySandboxBundleIndex,
  type FoundryArtifactManifest,
  FoundryArtifactError,
  FoundrySandboxArchiveError,
  FoundrySandboxArchiveManifest,
  FoundrySandboxArchiveReceipt,
  FoundrySandboxSetupArchive,
  FoundrySandboxSetupIndex,
  FOUNDRY_SETUP_PART_BYTES,
  type FoundrySandboxSetupReceipt,
  type FoundrySandboxEnvironmentReceipt,
  type EnvironmentId,
  type FoundryArchiveOwner,
  type ThreadId,
} from "@t3tools/contracts";
import { artifactSha256, downloadArtifact } from "@t3tools/shared/foundryArtifacts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { decodeSandboxBundleIndex } from "./SandboxBundle.ts";
import * as Schema from "effect/Schema";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import * as Artifacts from "./Artifacts.ts";
import * as ThreadArchive from "./ThreadArchive.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { makeCheckpointWorkspaceTree } from "./CheckpointWorkspace.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

type Manifest = FoundrySandboxArchiveManifest;
type Receipt = FoundrySandboxArchiveReceipt;
type Identity = Pick<Manifest, "allocationId" | "fence" | "owner">;
type Restored = Pick<Manifest, "headCommit" | "checkpointCommit" | "checkpointTree"> & {
  readonly source: FoundryArchiveOwner;
};
export class SandboxArchive extends Context.Service<
  SandboxArchive,
  {
    readonly capture: (input: {
      readonly allocationId: string;
      readonly fence: number;
      readonly cwd: string;
      readonly relativeWorkspacePath?: string;
      readonly checkpointRef: string;
      readonly sharedWorkspace?: Manifest;
      readonly threadId: ThreadId;
      readonly attachmentsDir: string;
    }) => Effect.Effect<Manifest, FoundrySandboxArchiveError>;
    readonly restore: (input: {
      readonly receipt: Receipt;
      readonly cwd: string;
      readonly bundlePath?: string;
      readonly bundleIndexPath?: string;
    }) => Effect.Effect<Restored, FoundrySandboxArchiveError>;
  }
>()("t3/foundry/SandboxArchive") {}

export class SandboxArchiveConfirmation extends Context.Service<
  SandboxArchiveConfirmation,
  {
    readonly confirmEnvironment: (
      principal: ThreadArchive.FoundryArchivePrincipal,
      manifests: ReadonlyArray<Manifest>,
      expected: {
        readonly allocationId: string;
        readonly fence: number;
        readonly environmentId: EnvironmentId;
        readonly threadIds: ReadonlyArray<ThreadId>;
      },
    ) => Effect.Effect<FoundrySandboxEnvironmentReceipt, FoundrySandboxArchiveError>;
    readonly confirmSetup: (
      principal: ThreadArchive.FoundryArchivePrincipal,
      archive: FoundrySandboxSetupArchive,
      expected: Identity & {
        readonly setupAdmitted: boolean;
        readonly runtimeAdmitted: boolean;
        readonly snapshotThreadIds?: ReadonlyArray<ThreadId>;
        readonly environmentId?: EnvironmentId;
      },
    ) => Effect.Effect<FoundrySandboxSetupReceipt, FoundrySandboxArchiveError>;
    readonly confirm: (
      principal: ThreadArchive.FoundryArchivePrincipal,
      manifest: Manifest,
      expected: Identity,
    ) => Effect.Effect<Receipt, FoundrySandboxArchiveError>;
  }
>()("t3/foundry/SandboxArchive/SandboxArchiveConfirmation") {}

const decodeIdentity = Schema.decodeEffect(
  Schema.Struct({
    allocationId: FoundrySandboxArchiveManifest.fields.allocationId,
    fence: FoundrySandboxArchiveManifest.fields.fence,
  }),
);
const decodeAttachment = Schema.decodeEffect(ChatFileAttachment);
const decodeSetupIndex = Schema.decodeEffect(Schema.fromJsonString(FoundrySandboxSetupIndex));
const decodeSetup = Schema.decodeEffect(FoundrySandboxSetupArchive, { onExcessProperty: "error" });
const decodeManifest = Schema.decodeEffect(FoundrySandboxArchiveManifest, {
  onExcessProperty: "error",
});
const decodeReceipt = Schema.decodeEffect(FoundrySandboxArchiveReceipt, {
  onExcessProperty: "error",
});
const encodeBundleIndex = Schema.encodeEffect(Schema.fromJsonString(FoundrySandboxBundleIndex));
const isArchiveError = Schema.is(FoundrySandboxArchiveError);
const isArtifactError = Schema.is(FoundryArtifactError);
const operationError = (cause: unknown) =>
  isArchiveError(cause)
    ? cause
    : new FoundrySandboxArchiveError({
        code: Schema.isSchemaError(cause)
          ? "invalid_request"
          : isArtifactError(cause) && cause.code === "changed"
            ? "changed"
            : "unavailable",
      });
const digest = (manifest: Manifest) =>
  artifactSha256(new TextEncoder().encode(stableStringify(manifest)));
const checkpointRef = (manifest: Pick<Manifest, "allocationId" | "fence">) =>
  `refs/foundry/sandbox-archive/${manifest.allocationId}/${manifest.fence}`;
const sameOwner = (a: FoundryArchiveOwner, b: FoundryArchiveOwner) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

const makeBundleOperations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const makeTemporary = Effect.fn("SandboxArchive.makeStagingDirectory")(function* () {
    const state = yield* fs.realPath(config.stateDir);
    const staging = path.join(state, "foundry-sandbox-staging");
    yield* fs.makeDirectory(staging, { recursive: true, mode: 0o700 });
    const info = yield* fs.stat(staging);
    if (
      info.type !== "Directory" ||
      (info.mode & 0o077) !== 0 ||
      (yield* fs.realPath(staging)) !== staging
    )
      return yield* new FoundrySandboxArchiveError({ code: "unavailable" });
    return yield* fs.makeTempDirectoryScoped({ directory: staging, prefix: "bundle-" });
  });
  const run = Effect.fn("SandboxArchive.git")(function* (cwd: string, args: ReadonlyArray<string>) {
    return (yield* git.execute({
      cwd,
      operation: "foundry.sandbox.archive",
      args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    })).stdout.trim();
  });
  const fetchBase = Effect.fn("SandboxArchive.fetchBase")(function* (
    repository: string,
    base: NonNullable<Manifest["remoteBase"]>,
  ) {
    if (/[@?#\r\n]/.test(base.url) || base.url.startsWith("-"))
      return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
    yield* run(repository, ["fetch", "--no-tags", "--", base.url, base.commit]).pipe(
      Effect.mapError(() => new FoundrySandboxArchiveError({ code: "remote_base_unavailable" })),
    );
    if ((yield* run(repository, ["rev-parse", "FETCH_HEAD^{commit}"])) !== base.commit)
      return yield* new FoundrySandboxArchiveError({ code: "remote_base_unavailable" });
  });
  const remoteBase = Effect.fn("SandboxArchive.remoteBase")(function* (cwd: string) {
    const url = yield* run(cwd, ["remote", "get-url", "origin"]).pipe(
      Effect.mapError(() => new FoundrySandboxArchiveError({ code: "remote_base_unavailable" })),
    );
    if (/[@?#\r\n]/.test(url) || url.startsWith("-"))
      return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
    const temporary = yield* makeTemporary();
    yield* run(temporary, ["init"]);
    yield* run(temporary, [
      "fetch",
      "--no-tags",
      "--",
      url,
      "+refs/heads/*:refs/remotes/base/*",
    ]).pipe(
      Effect.mapError(() => new FoundrySandboxArchiveError({ code: "remote_base_unavailable" })),
    );
    const refs = (yield* run(temporary, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/remotes/base/",
    ]))
      .split("\n")
      .filter(Boolean);
    // Import only remote objects to find an ancestor; never publish local work.
    yield* run(cwd, [
      "fetch",
      "--no-tags",
      "--",
      temporary,
      "+refs/remotes/base/*:refs/foundry/remote-base/*",
    ]);
    let best: { commit: string; distance: number } | undefined;
    for (const ref of refs) {
      const commit = yield* run(cwd, ["merge-base", "HEAD", ref]).pipe(Effect.option);
      if (Option.isSome(commit)) {
        const distance = Number(
          yield* run(cwd, ["rev-list", "--count", "HEAD", `^${commit.value}`]),
        );
        if (!best || distance < best.distance) best = { commit: commit.value, distance };
      }
    }
    if (best) {
      const base = { format: "foundry-remote-delta-2" as const, url, commit: best.commit };
      const probe = yield* makeTemporary();
      yield* run(probe, ["init"]);
      yield* fetchBase(probe, base);
      return base;
    }
    return yield* new FoundrySandboxArchiveError({ code: "remote_base_unavailable" });
  });
  const hashFile = Effect.fn("SandboxArchive.hashFile")(function* (filePath: string) {
    const reader = yield* fs.open(filePath, { flag: "r" });
    const hash = NodeCrypto.createHash("sha256");
    let sizeBytes = 0;
    while (true) {
      const next = yield* reader.readAlloc(FOUNDRY_SANDBOX_BUNDLE_PART_BYTES);
      if (Option.isNone(next)) break;
      sizeBytes += next.value.byteLength;
      if (sizeBytes > FOUNDRY_SANDBOX_BUNDLE_MAX_BYTES)
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      hash.update(next.value);
    }
    return { sizeBytes, sha256: hash.digest("hex") };
  });
  const readIndexFile = Effect.fn("SandboxArchive.readIndexFile")(function* (filePath: string) {
    if ((yield* fs.stat(filePath)).size > 1024n * 1024n)
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    return yield* fs.readFile(filePath);
  });
  const assemble = Effect.fn("SandboxArchive.assembleBundle")(function* (
    root: FoundryArtifactManifest,
    read: (
      reference: FoundryArtifactManifest["reference"],
    ) => Effect.Effect<
      { readonly manifest: FoundryArtifactManifest; readonly bytes: Uint8Array },
      FoundryArtifactError
    >,
  ) {
    if (root.mimeType === FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE && root.sizeBytes > 1024 * 1024)
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    const downloaded = yield* read(root.reference);
    if (stableStringify(downloaded.manifest) !== stableStringify(root))
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    const temporary = yield* makeTemporary();
    const bundlePath = path.join(temporary, "source.bundle");
    if (root.mimeType !== FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE) {
      if (
        downloaded.bytes.byteLength !== root.sizeBytes ||
        artifactSha256(downloaded.bytes) !== root.sha256
      )
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      yield* fs.writeFile(bundlePath, downloaded.bytes);
      return { bundlePath, expected: root };
    }
    const index = yield* decodeSandboxBundleIndex(root, downloaded.bytes);
    const writer = yield* fs.open(bundlePath, { flag: "wx", mode: 0o600 });
    for (const part of index.parts) {
      const value = yield* read(part.reference);
      if (
        stableStringify(value.manifest) !== stableStringify(part) ||
        value.bytes.byteLength !== part.sizeBytes ||
        artifactSha256(value.bytes) !== part.sha256
      )
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      yield* writer.writeAll(value.bytes);
    }
    yield* writer.sync;
    return { bundlePath, expected: index };
  });
  const verify = Effect.fn("SandboxArchive.verifyBundle")(function* (
    manifest: Manifest,
    bundlePath: string,
    expected: { readonly sizeBytes: number; readonly sha256: string },
  ) {
    if (manifest.bundleSizeBytes !== undefined && manifest.bundleSizeBytes !== expected.sizeBytes)
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    if ((yield* fs.stat(bundlePath)).size !== BigInt(expected.sizeBytes))
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    const actual = yield* hashFile(bundlePath);
    if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256)
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    const temporary = yield* makeTemporary();
    const repository = path.join(temporary, "repository");
    yield* fs.makeDirectory(repository);
    yield* run(repository, ["init"]);
    if (manifest.remoteBase) yield* fetchBase(repository, manifest.remoteBase);
    yield* run(repository, ["bundle", "verify", bundlePath]);
    const heads = (yield* run(repository, ["bundle", "list-heads", bundlePath])).split("\n").sort();
    const expectedHeads = [
      ...(manifest.remoteBase?.commit === manifest.headCommit
        ? []
        : [`${manifest.headCommit} HEAD`]),
      `${manifest.checkpointCommit} ${checkpointRef(manifest)}`,
    ].sort();
    if (stableStringify(heads) !== stableStringify(expectedHeads))
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    yield* run(repository, [
      "fetch",
      "--no-tags",
      "--",
      bundlePath,
      ...(manifest.remoteBase?.commit === manifest.headCommit
        ? []
        : ["+HEAD:refs/foundry/archive-head"]),
      `+${checkpointRef(manifest)}:refs/foundry/archive-checkpoint`,
    ]);
    if (manifest.remoteBase?.commit === manifest.headCommit)
      yield* run(repository, ["update-ref", "refs/foundry/archive-head", manifest.headCommit]);
    if (
      (yield* run(repository, ["rev-parse", "refs/foundry/archive-checkpoint^{tree}"])) !==
      manifest.checkpointTree
    )
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    yield* run(repository, ["fsck", "--strict", "--no-reflogs"]);
    return { bundlePath, repository };
  });
  return { run, verify, assemble, readIndexFile, makeTemporary, remoteBase };
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const publication = yield* ArtifactPublication.ArtifactPublication;
  const archive = yield* ArchivePublication.ArchivePublication;
  const workspaceTree = yield* makeCheckpointWorkspaceTree();
  const { run, verify, assemble, readIndexFile, makeTemporary, remoteBase } =
    yield* makeBundleOperations;
  const capture = Effect.fn("SandboxArchive.capture")(
    function* (input: Parameters<SandboxArchive["Service"]["capture"]>[0]) {
      if (!publication || !archive)
        return yield* new FoundrySandboxArchiveError({ code: "unavailable" });
      yield* decodeIdentity({ allocationId: input.allocationId, fence: input.fence });
      if (!input.checkpointRef.startsWith("refs/"))
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const base = yield* remoteBase(input.cwd);
      const headCommit = yield* run(input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const checkpointCommit = yield* run(input.cwd, [
        "rev-parse",
        "--verify",
        `${input.checkpointRef}^{commit}`,
      ]);
      const checkpointTree = yield* run(input.cwd, ["rev-parse", `${checkpointCommit}^{tree}`]);
      if ((yield* workspaceTree(input.cwd, checkpointCommit)) !== checkpointTree)
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      const status = yield* archive.reconcile(input.threadId);
      if (!status.complete) return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
      if (input.sharedWorkspace) {
        const shared = input.sharedWorkspace;
        if (
          shared.allocationId !== input.allocationId ||
          shared.fence !== input.fence ||
          shared.owner.environmentId !== status.owner.environmentId ||
          shared.headCommit !== headCommit ||
          shared.checkpointCommit !== checkpointCommit ||
          shared.checkpointTree !== checkpointTree ||
          stableStringify(shared.remoteBase) !== stableStringify(base)
        )
          return yield* new FoundrySandboxArchiveError({ code: "changed" });
        return {
          ...shared,
          owner: status.owner,
          finalCursor: status.confirmedCursor,
          finalSourceSequence: status.confirmedSourceSequence,
        };
      }
      const ref = checkpointRef(input);
      yield* run(input.cwd, ["update-ref", ref, checkpointCommit]);
      const temporary = yield* makeTemporary();
      const bundlePath = path.join(temporary, "sandbox.bundle");
      yield* run(input.cwd, ["bundle", "create", bundlePath, "HEAD", ref, `^${base.commit}`]);
      if ((yield* fs.stat(bundlePath)).size > BigInt(FOUNDRY_SANDBOX_BUNDLE_MAX_BYTES))
        return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
      const publish = Effect.fn("SandboxArchive.publishBundlePart")(function* (
        bytes: Uint8Array,
        suffix: string,
        mimeType: string,
      ) {
        const id = createDeterministicAttachmentId(
          input.threadId,
          `sandbox:${input.allocationId}:${input.fence}:${suffix}`,
        );
        if (!id) return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
        const attachment = yield* decodeAttachment({
          type: "file",
          id: ChatAttachmentId.make(id),
          name: `foundry-sandbox-${suffix}`,
          mimeType,
          sizeBytes: bytes.byteLength,
        });
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: input.attachmentsDir,
          attachment,
        });
        if (!attachmentPath)
          return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
        yield* fs.writeFile(attachmentPath, bytes, { mode: 0o600 });
        const published = yield* publication.publishAttachment(
          input.threadId,
          attachment,
          `sandbox:${input.allocationId}:${input.fence}:${suffix}`,
        );
        if (!published.foundryArtifact)
          return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
        return published.foundryArtifact;
      });
      const reader = yield* fs.open(bundlePath, { flag: "r" });
      const parts: FoundryArtifactManifest[] = [];
      const hash = NodeCrypto.createHash("sha256");
      let sizeBytes = 0;
      while (true) {
        const next = yield* reader.readAlloc(FOUNDRY_SANDBOX_BUNDLE_PART_BYTES);
        if (Option.isNone(next)) break;
        sizeBytes += next.value.byteLength;
        if (sizeBytes > FOUNDRY_SANDBOX_BUNDLE_MAX_BYTES)
          return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
        hash.update(next.value);
        if (parts.length >= FOUNDRY_SANDBOX_BUNDLE_MAX_PARTS)
          return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
        parts.push(
          yield* publish(next.value, `bundle-part-${parts.length}`, "application/octet-stream"),
        );
      }
      const index = {
        format: "foundry-git-bundle-1" as const,
        sizeBytes,
        sha256: hash.digest("hex"),
        parts,
      };
      const indexBytes = new TextEncoder().encode(yield* encodeBundleIndex(index));
      if (indexBytes.byteLength > 1024 * 1024)
        return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
      const root = yield* publish(
        indexBytes,
        "bundle-index.json",
        FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE,
      );
      const manifest = yield* decodeManifest({
        allocationId: input.allocationId,
        fence: input.fence,
        owner: status.owner,
        relativeWorkspacePath: input.relativeWorkspacePath ?? "repo",
        finalCursor: status.confirmedCursor,
        finalSourceSequence: status.confirmedSourceSequence,
        remoteBase: base,
        headCommit,
        checkpointCommit,
        checkpointTree,
        bundleSizeBytes: sizeBytes,
        bundle: root,
      });
      yield* decodeSandboxBundleIndex(root, indexBytes);
      yield* verify(manifest, bundlePath, index);
      const final = yield* archive.reconcile(input.threadId);
      if (
        !final.complete ||
        final.confirmedCursor !== manifest.finalCursor ||
        final.confirmedSourceSequence !== manifest.finalSourceSequence ||
        (yield* run(input.cwd, ["rev-parse", "HEAD"])) !== headCommit ||
        (yield* workspaceTree(input.cwd, checkpointCommit)) !== checkpointTree
      )
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      return manifest;
    },
    Effect.scoped,
    Effect.mapError(operationError),
  );
  const restore = Effect.fn("SandboxArchive.restore")(
    function* (input: Parameters<SandboxArchive["Service"]["restore"]>[0]) {
      if (!publication && !input.bundlePath)
        return yield* new FoundrySandboxArchiveError({ code: "unavailable" });
      const receipt = yield* decodeReceipt(input.receipt);
      const manifest = receipt.manifest;
      if (digest(manifest) !== receipt.digest)
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      if ((yield* fs.readDirectory(input.cwd)).length !== 0)
        return yield* new FoundrySandboxArchiveError({ code: "destination_not_empty" });
      let source: {
        bundlePath: string;
        expected: { readonly sizeBytes: number; readonly sha256: string };
      };
      if (input.bundlePath) {
        const expected =
          manifest.bundle.mimeType === FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE
            ? yield* decodeSandboxBundleIndex(
                manifest.bundle,
                input.bundleIndexPath
                  ? yield* readIndexFile(input.bundleIndexPath)
                  : publication
                    ? (yield* publication.download(manifest.bundle.reference)).bytes
                    : yield* new FoundrySandboxArchiveError({ code: "invalid_request" }),
              )
            : manifest.bundle;
        source = { bundlePath: input.bundlePath, expected };
      } else source = yield* assemble(manifest.bundle, publication!.download);
      const { repository } = yield* verify(manifest, source.bundlePath, source.expected);
      yield* run(input.cwd, ["init"]);
      yield* run(input.cwd, [
        "fetch",
        "--no-tags",
        "--",
        repository,
        "+refs/foundry/archive-head:refs/foundry/archive-head",
        "+refs/foundry/archive-checkpoint:refs/foundry/archive-checkpoint",
      ]);
      if (manifest.remoteBase)
        yield* run(input.cwd, ["remote", "add", "origin", manifest.remoteBase.url]);
      yield* run(input.cwd, ["checkout", "--detach", manifest.headCommit]);
      yield* run(input.cwd, ["read-tree", "--reset", "-u", manifest.checkpointCommit]);
      yield* run(input.cwd, ["reset", "--mixed", manifest.headCommit]);
      if ((yield* workspaceTree(input.cwd, manifest.checkpointCommit)) !== manifest.checkpointTree)
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      return {
        source: manifest.owner,
        headCommit: manifest.headCommit,
        checkpointCommit: manifest.checkpointCommit,
        checkpointTree: manifest.checkpointTree,
      };
    },
    Effect.scoped,
    Effect.mapError(operationError),
  );
  return SandboxArchive.of({ capture, restore });
});
export const layer = Layer.effect(SandboxArchive, make);

export const layerConfirmation = Layer.effect(
  SandboxArchiveConfirmation,
  Effect.gen(function* () {
    const archives = yield* ThreadArchive.ThreadArchive;
    const artifacts = yield* Artifacts.Artifacts;
    const { verify, assemble } = yield* makeBundleOperations;
    const confirmation: SandboxArchiveConfirmation["Service"] = SandboxArchiveConfirmation.of({
      confirmEnvironment: Effect.fn("SandboxArchiveConfirmation.confirmEnvironment")(function* (
        principal,
        manifests,
        expected,
      ) {
        const wanted = new Set(expected.threadIds);
        if (
          wanted.size === 0 ||
          wanted.size > 128 ||
          wanted.size !== expected.threadIds.length ||
          manifests.length !== wanted.size ||
          new Set(manifests.map((manifest) => manifest.owner.threadId)).size !== wanted.size
        )
          return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
        for (const manifest of manifests) {
          if (
            manifest.owner.environmentId !== expected.environmentId ||
            !wanted.has(manifest.owner.threadId) ||
            manifests.some(
              (other) =>
                other.relativeWorkspacePath === manifest.relativeWorkspacePath &&
                (other.headCommit !== manifest.headCommit ||
                  other.checkpointCommit !== manifest.checkpointCommit ||
                  other.checkpointTree !== manifest.checkpointTree),
            )
          )
            return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
        }
        let before: string | undefined;
        do {
          const page = yield* archives.list(principal, before ? { before } : {});
          if (
            page.items.some(
              (item) =>
                item.owner.environmentId === expected.environmentId &&
                !wanted.has(item.owner.threadId),
            )
          )
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          before = page.nextCursor ?? undefined;
        } while (before !== undefined);
        const threads = yield* Effect.forEach(
          [...manifests].sort((a, b) => a.owner.threadId.localeCompare(b.owner.threadId)),
          (manifest) =>
            confirmation.confirm(principal, manifest, {
              allocationId: expected.allocationId,
              fence: expected.fence,
              owner: manifest.owner,
            }),
        );
        for (const manifest of manifests) {
          const final = yield* archives.cursor(principal, manifest.owner);
          if (
            !final.complete ||
            final.confirmedCursor !== manifest.finalCursor ||
            final.confirmedSourceSequence !== manifest.finalSourceSequence
          )
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
        }
        const receipt = {
          kind: "environment" as const,
          allocationId: expected.allocationId,
          fence: expected.fence,
          threads,
        };
        return {
          ...receipt,
          digest: artifactSha256(new TextEncoder().encode(stableStringify(receipt))),
        };
      }, Effect.mapError(operationError)),
      confirmSetup: Effect.fn("SandboxArchiveConfirmation.confirmSetup")(function* (
        principal,
        raw,
        expected,
      ) {
        const archive = yield* decodeSetup(raw);
        if (
          archive.allocationId !== expected.allocationId ||
          archive.fence !== expected.fence ||
          (archive.kind === "empty" && (expected.setupAdmitted || expected.runtimeAdmitted))
        )
          return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
        if (expected.runtimeAdmitted) {
          if (
            !expected.environmentId ||
            !expected.snapshotThreadIds ||
            expected.snapshotThreadIds.length !== 0
          )
            return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
          let before: string | undefined;
          do {
            const page = yield* archives.list(principal, before ? { before } : {});
            if (page.items.some((item) => item.owner.environmentId === expected.environmentId))
              return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
            before = page.nextCursor ?? undefined;
          } while (before !== undefined);
        }
        if (archive.kind === "setup") {
          if (
            !sameOwner(archive.artifact.reference.owner, expected.owner) ||
            archive.artifact.reference.instanceId !== principal.instanceId ||
            archive.artifact.sizeBytes > FOUNDRY_SETUP_PART_BYTES
          )
            return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
          const downloaded = yield* downloadArtifact((request) => {
            if (request.op === "metadata") return artifacts.metadata(principal, request.input);
            if (request.op === "read") return artifacts.read(principal, request.input);
            return Effect.fail(new FoundryArtifactError({ code: "invalid_request" }));
          }, archive.artifact.reference);
          if (stableStringify(downloaded.manifest) !== stableStringify(archive.artifact))
            return yield* new FoundrySandboxArchiveError({ code: "changed" });
          const index = yield* decodeSetupIndex(new TextDecoder().decode(downloaded.bytes));
          const seen = new Set<string>();
          for (const part of index.parts) {
            if (
              !sameOwner(part.reference.owner, expected.owner) ||
              part.reference.instanceId !== principal.instanceId ||
              part.sizeBytes > FOUNDRY_SETUP_PART_BYTES ||
              seen.has(part.reference.artifactId) ||
              part.reference.artifactId === archive.artifact.reference.artifactId
            )
              return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
            seen.add(part.reference.artifactId);
            const published = yield* artifacts.metadata(principal, part.reference);
            if (stableStringify(published) !== stableStringify(part))
              return yield* new FoundrySandboxArchiveError({ code: "changed" });
            // Idempotent publication verifies the durable blob hash without re-encoding every chunk.
            const confirmed = yield* artifacts.publish(principal, part.reference);
            if (stableStringify(confirmed) !== stableStringify(part))
              return yield* new FoundrySandboxArchiveError({ code: "changed" });
          }
        }
        return {
          archive,
          digest: artifactSha256(new TextEncoder().encode(stableStringify(archive))),
        };
      }, Effect.mapError(operationError)),
      confirm: Effect.fn("SandboxArchiveConfirmation.confirm")(
        function* (
          principal: ThreadArchive.FoundryArchivePrincipal,
          raw: Manifest,
          expected: Identity,
        ) {
          const manifest = yield* decodeManifest(raw);
          if (
            manifest.allocationId !== expected.allocationId ||
            manifest.fence !== expected.fence ||
            !sameOwner(manifest.owner, expected.owner) ||
            manifest.bundle.reference.owner.environmentId !== manifest.owner.environmentId ||
            manifest.bundle.reference.instanceId !== principal.instanceId
          )
            return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
          const status = yield* archives.cursor(principal, manifest.owner);
          if (
            !status.complete ||
            status.confirmedCursor !== manifest.finalCursor ||
            status.confirmedSourceSequence !== manifest.finalSourceSequence
          )
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          const read = (reference: FoundryArtifactManifest["reference"]) =>
            artifacts.readVerified
              ? artifacts.readVerified(principal, reference)
              : downloadArtifact((request) => {
                  if (request.op === "metadata")
                    return artifacts.metadata(principal, request.input);
                  if (request.op === "read") return artifacts.read(principal, request.input);
                  return Effect.fail(new FoundryArtifactError({ code: "invalid_request" }));
                }, reference);
          const source = yield* assemble(manifest.bundle, read);
          yield* verify(manifest, source.bundlePath, source.expected);
          const final = yield* archives.cursor(principal, manifest.owner);
          if (
            !final.complete ||
            final.confirmedCursor !== manifest.finalCursor ||
            final.confirmedSourceSequence !== manifest.finalSourceSequence
          )
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          return { manifest, digest: digest(manifest) };
        },
        Effect.scoped,
        Effect.mapError(operationError),
      ),
    });
    return confirmation;
  }),
);
