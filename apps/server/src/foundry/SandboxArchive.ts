import {
  ChatAttachmentId,
  ChatFileAttachment,
  FOUNDRY_ARTIFACT_MAX_BYTES,
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
import * as Schema from "effect/Schema";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import * as Artifacts from "./Artifacts.ts";
import * as ThreadArchive from "./ThreadArchive.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
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
      readonly threadId: ThreadId;
      readonly attachmentsDir: string;
    }) => Effect.Effect<Manifest, FoundrySandboxArchiveError>;
    readonly restore: (input: {
      readonly receipt: Receipt;
      readonly cwd: string;
      readonly bundlePath?: string;
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
const isArchiveError = Schema.is(FoundrySandboxArchiveError);
const operationError = (cause: unknown) =>
  isArchiveError(cause)
    ? cause
    : new FoundrySandboxArchiveError({
        code: Schema.isSchemaError(cause) ? "invalid_request" : "unavailable",
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
  const run = Effect.fn("SandboxArchive.git")(function* (cwd: string, args: ReadonlyArray<string>) {
    return (yield* git.execute({
      cwd,
      operation: "foundry.sandbox.archive",
      args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    })).stdout.trim();
  });
  const verify = Effect.fn("SandboxArchive.verifyBundle")(function* (
    manifest: Manifest,
    bytes: Uint8Array,
  ) {
    if (
      bytes.byteLength !== manifest.bundle.sizeBytes ||
      artifactSha256(bytes) !== manifest.bundle.sha256
    )
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    const temporary = yield* fs.makeTempDirectoryScoped();
    const bundlePath = path.join(temporary, "source.bundle");
    const repository = path.join(temporary, "repository");
    yield* fs.writeFile(bundlePath, bytes);
    yield* fs.makeDirectory(repository);
    yield* run(repository, ["init"]);
    yield* run(repository, ["bundle", "verify", bundlePath]);
    const heads = (yield* run(repository, ["bundle", "list-heads", bundlePath])).split("\n").sort();
    const expected = [
      `${manifest.headCommit} HEAD`,
      `${manifest.checkpointCommit} ${checkpointRef(manifest)}`,
    ].sort();
    if (stableStringify(heads) !== stableStringify(expected))
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    yield* run(repository, [
      "fetch",
      "--no-tags",
      "--",
      bundlePath,
      "+HEAD:refs/foundry/archive-head",
      `+${checkpointRef(manifest)}:refs/foundry/archive-checkpoint`,
    ]);
    if (
      (yield* run(repository, ["rev-parse", "refs/foundry/archive-checkpoint^{tree}"])) !==
      manifest.checkpointTree
    )
      return yield* new FoundrySandboxArchiveError({ code: "changed" });
    yield* run(repository, ["fsck", "--strict", "--no-reflogs"]);
    return { bundlePath, repository };
  });
  return { run, verify };
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const publication = yield* ArtifactPublication.ArtifactPublication;
  const archive = yield* ArchivePublication.ArchivePublication;
  const workspaceTree = yield* makeCheckpointWorkspaceTree();
  const { run, verify } = yield* makeBundleOperations;
  const capture = Effect.fn("SandboxArchive.capture")(
    function* (input: Parameters<SandboxArchive["Service"]["capture"]>[0]) {
      if (!publication || !archive)
        return yield* new FoundrySandboxArchiveError({ code: "unavailable" });
      yield* decodeIdentity({ allocationId: input.allocationId, fence: input.fence });
      if (!input.checkpointRef.startsWith("refs/"))
        return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
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
      const ref = checkpointRef(input);
      yield* run(input.cwd, ["update-ref", ref, checkpointCommit]);
      const temporary = yield* fs.makeTempDirectoryScoped();
      const bundlePath = path.join(temporary, "sandbox.bundle");
      yield* run(input.cwd, ["bundle", "create", bundlePath, "HEAD", ref]);
      if ((yield* fs.stat(bundlePath)).size > BigInt(FOUNDRY_ARTIFACT_MAX_BYTES))
        return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
      const bytes = yield* fs.readFile(bundlePath);
      const id = createDeterministicAttachmentId(
        input.threadId,
        `sandbox:${input.allocationId}:${input.fence}`,
      );
      if (!id) return yield* new FoundrySandboxArchiveError({ code: "invalid_request" });
      const attachment = yield* decodeAttachment({
        type: "file",
        id: ChatAttachmentId.make(id),
        name: "foundry-sandbox.bundle",
        mimeType: "application/octet-stream",
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
        `sandbox:${input.allocationId}:${input.fence}`,
      );
      if (!published.foundryArtifact)
        return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
      const manifest = yield* decodeManifest({
        allocationId: input.allocationId,
        fence: input.fence,
        owner: status.owner,
        relativeWorkspacePath: input.relativeWorkspacePath ?? "repo",
        finalCursor: status.confirmedCursor,
        finalSourceSequence: status.confirmedSourceSequence,
        headCommit,
        checkpointCommit,
        checkpointTree,
        bundle: published.foundryArtifact,
      });
      yield* verify(manifest, bytes);
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
      if (
        input.bundlePath &&
        (yield* fs.stat(input.bundlePath)).size > BigInt(FOUNDRY_ARTIFACT_MAX_BYTES)
      )
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      const downloaded = input.bundlePath
        ? { manifest: manifest.bundle, bytes: yield* fs.readFile(input.bundlePath) }
        : yield* publication!.download(manifest.bundle.reference);
      if (stableStringify(downloaded.manifest) !== stableStringify(manifest.bundle))
        return yield* new FoundrySandboxArchiveError({ code: "changed" });
      const { repository } = yield* verify(manifest, downloaded.bytes);
      yield* run(input.cwd, ["init"]);
      yield* run(input.cwd, [
        "fetch",
        "--no-tags",
        "--",
        repository,
        "+refs/foundry/archive-head:refs/foundry/archive-head",
        "+refs/foundry/archive-checkpoint:refs/foundry/archive-checkpoint",
      ]);
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
    const { verify } = yield* makeBundleOperations;
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
            !sameOwner(manifest.bundle.reference.owner, manifest.owner) ||
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
          const downloaded = yield* downloadArtifact((request) => {
            if (request.op === "metadata") return artifacts.metadata(principal, request.input);
            if (request.op === "read") return artifacts.read(principal, request.input);
            return Effect.fail(new FoundryArtifactError({ code: "invalid_request" }));
          }, manifest.bundle.reference);
          if (stableStringify(downloaded.manifest) !== stableStringify(manifest.bundle))
            return yield* new FoundrySandboxArchiveError({ code: "changed" });
          yield* verify(manifest, downloaded.bytes);
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
