import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import {
  EnvironmentId,
  FoundryArtifactId,
  FoundrySandboxSetupIndex,
  FoundryDeviceId,
  FoundryInstanceId,
  ThreadId,
  FoundryArtifactError,
  type FoundryArtifactManifest,
  type FoundryArchiveStatus,
  type ChatAttachment,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { decodeSandboxBundleIndex } from "./SandboxBundle.ts";
import * as SandboxArchiveEnvironment from "./SandboxArchiveEnvironment.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as SandboxArchive from "./SandboxArchive.ts";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import * as ThreadArchive from "./ThreadArchive.ts";
import * as Artifacts from "./Artifacts.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const encodeWorkspace = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ worktreePath: Schema.String })),
);
const infrastructure = Git.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "sandbox-archive-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const encodeSetupIndex = Schema.encodeEffect(Schema.fromJsonString(FoundrySandboxSetupIndex));

it.live(
  "confirms actual Git objects and final events, then restores dirty checkpoint files after source deletion",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const config = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped();
      const cwd = `${root}/source`;
      const attachmentsDir = `${root}/attachments`;
      yield* fs.makeDirectory(cwd);
      yield* fs.makeDirectory(attachmentsDir);
      const run = Effect.fn("SandboxArchiveTest.git")(function* (args: ReadonlyArray<string>) {
        return (yield* git.execute({ cwd, operation: "sandbox.archive.test", args })).stdout.trim();
      });
      yield* run(["init"]);
      yield* run(["config", "user.name", "Foundry Fixture"]);
      yield* run(["config", "user.email", "fixture@invalid.test"]);
      yield* fs.writeFileString(`${cwd}/file.txt`, "original\n");
      yield* run(["add", "."]);
      yield* run(["commit", "-m", "Original"]);
      const head = yield* run(["rev-parse", "HEAD"]);
      yield* fs.writeFileString(`${cwd}/file.txt`, "changed\n");
      yield* fs.writeFileString(`${cwd}/new.txt`, "untracked work\n");
      yield* run(["add", "."]);
      const tree = yield* run(["write-tree"]);
      const checkpoint = yield* run(["commit-tree", tree, "-p", head, "-m", "Checkpoint"]);
      yield* run(["update-ref", "refs/t3/checkpoint", checkpoint]);
      yield* run(["reset", "--mixed", "HEAD"]);
      const owner = {
        environmentId: EnvironmentId.make("sandbox-source"),
        threadId: ThreadId.make("sandbox-thread"),
      };
      const instanceId = FoundryInstanceId.make("8a816ac1-e6df-4a72-bb9a-506cfec5f04c");
      const principal = { instanceId, operatorId: "operator" };
      let status: FoundryArchiveStatus = {
        owner,
        complete: true,
        sourceComplete: true,
        sourceHead: 3,
        confirmedCursor: 3,
        confirmedSourceSequence: 9,
        missingArtifacts: [],
        missingAttachmentCount: 0,
      };
      let advanceDuringDownload = false;
      let denyDownload = false;
      let unlistedThread = false;
      let lateBatchCursor = 0;
      let artifact: { manifest: FoundryArtifactManifest; bytes: Uint8Array } | undefined;
      const setupArtifacts = new Map<
        string,
        { manifest: FoundryArtifactManifest; bytes: Uint8Array }
      >();
      const bulkSetupArtifacts = new Set<string>();
      const findArtifact = (id: string) =>
        setupArtifacts.get(id) ??
        (artifact?.manifest.reference.artifactId === id ? artifact : undefined);
      const unavailable = () => new FoundryArtifactError({ code: "unavailable" });
      const bundleCreates: string[] = [];
      const external = Layer.mergeAll(
        Layer.succeed(
          Git.GitVcsDriver,
          Git.GitVcsDriver.of({
            ...git,
            execute: Effect.fn("SandboxArchiveTest.execute")(function* (input) {
              const bundle = input.args.indexOf("bundle");
              if (input.args[bundle + 1] === "create") bundleCreates.push(input.args[bundle + 2]!);
              return yield* git.execute(input);
            }),
          }),
        ),
        Layer.succeed(ArtifactPublication.ArtifactPublication, {
          publishAttachment: Effect.fn("SandboxArchiveTest.publish")(function* <
            Attachment extends ChatAttachment,
          >(threadId: string, attachment: Attachment) {
            const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
            assert.isNotNull(attachmentPath);
            const bytes = yield* fs.readFile(attachmentPath!);
            const manifest = {
              reference: {
                instanceId,
                owner: { ...owner, threadId: ThreadId.make(threadId) },
                artifactId: FoundryArtifactId.make(
                  `00000000-0000-4000-8000-${artifactSha256(new TextEncoder().encode(attachment.id)).slice(0, 12)}`,
                ),
              },
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: bytes.byteLength,
              sha256: artifactSha256(bytes),
            };
            artifact = { manifest, bytes };
            setupArtifacts.set(manifest.reference.artifactId, artifact);
            return { ...attachment, foundryArtifact: manifest };
          }, Effect.mapError(unavailable)),
          download: (reference) => {
            if (denyDownload) return Effect.fail(unavailable());
            const value = findArtifact(reference.artifactId);
            return value ? Effect.succeed(value) : Effect.fail(unavailable());
          },
        }),
        Layer.succeed(ArchivePublication.ArchivePublication, {
          reconcile: (threadId) =>
            Effect.succeed({
              ...status,
              owner: { ...owner, threadId },
              instanceId,
              deviceId: FoundryDeviceId.make("3c40f18b-fb3d-4710-8235-74b66c003659"),
              deviceGeneration: 1,
            }),
        }),
        Layer.succeed(ThreadArchive.ThreadArchive, {
          cursor: () => {
            if (lateBatchCursor > 0 && ++lateBatchCursor === 4)
              status = { ...status, confirmedCursor: 4, sourceHead: 4 };
            return Effect.succeed(status);
          },
          ingest: () => Effect.die("Unexpected ingest"),
          read: () => Effect.die("Unexpected read"),
          list: () =>
            Effect.succeed({
              items: unlistedThread
                ? [
                    status,
                    { ...status, owner: { ...owner, threadId: ThreadId.make("other-thread") } },
                  ]
                : [status],
              nextCursor: null,
            }),
        }),
        Layer.succeed(Artifacts.Artifacts, {
          metadata: (_principal, input) => {
            if (advanceDuringDownload) status = { ...status, confirmedCursor: 4, sourceHead: 4 };
            const found = findArtifact(input.artifactId);
            return found ? Effect.succeed(found.manifest) : Effect.fail(unavailable());
          },
          read: (_principal, input) => {
            if (bulkSetupArtifacts.has(input.reference.artifactId))
              return Effect.fail(unavailable());
            const found = findArtifact(input.reference.artifactId);
            return found
              ? Effect.succeed({
                  offset: input.offset,
                  total: found.bytes.length,
                  fileSha256: found.manifest.sha256,
                  sha256: artifactSha256(found.bytes),
                  data: Base64.encode(found.bytes),
                })
              : Effect.fail(unavailable());
          },
          begin: () => Effect.die("Unexpected begin"),
          status: () => Effect.die("Unexpected status"),
          write: () => Effect.die("Unexpected write"),
          publish: (_principal, input) => {
            const found = findArtifact(input.artifactId);
            return found &&
              found.bytes.byteLength === found.manifest.sizeBytes &&
              artifactSha256(found.bytes) === found.manifest.sha256
              ? Effect.succeed(found.manifest)
              : Effect.fail(unavailable());
          },
          abort: () => Effect.die("Unexpected abort"),
          list: () => Effect.die("Unexpected list"),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* SandboxArchive.SandboxArchive;
        const confirmation = yield* SandboxArchive.SandboxArchiveConfirmation;
        const input = {
          allocationId: "6e913eaf-0330-490a-a612-5b9a48f29607",
          fence: 1,
          cwd,
          attachmentsDir,
          threadId: owner.threadId,
          checkpointRef: "refs/t3/checkpoint",
        };
        const manifest = yield* service.capture(input);
        assert.isTrue(yield* fs.exists(`${config.stateDir}/foundry-sandbox-staging`));
        assert.equal(bundleCreates.length, 1);
        assert.isTrue(
          bundleCreates[0]!.startsWith(`${config.stateDir}/foundry-sandbox-staging/bundle-`),
        );
        assert.deepEqual(yield* fs.readDirectory(`${config.stateDir}/foundry-sandbox-staging`), []);
        assert.equal(manifest.checkpointTree, tree);
        assert.equal(manifest.bundle.mimeType, "application/vnd.foundry.git-bundle-index+json");
        assert.deepEqual(yield* service.capture(input), manifest);
        const expected = { allocationId: input.allocationId, fence: 1, owner };
        const receipt = yield* confirmation.confirm(principal, manifest, expected);
        assert.deepEqual(yield* confirmation.confirm(principal, manifest, expected), receipt);
        const firstIndex = yield* decodeSandboxBundleIndex(manifest.bundle, artifact!.bytes);
        const full = setupArtifacts.get(firstIndex.parts[0]!.reference.artifactId)!;
        const midpoint = Math.floor(full.bytes.length / 2);
        const split = [full.bytes.slice(0, midpoint), full.bytes.slice(midpoint)];
        const splitParts = split.map((bytes, index) => {
          const part = {
            ...full.manifest,
            reference: {
              ...full.manifest.reference,
              artifactId: FoundryArtifactId.make(`99999999-9999-4999-8999-00000000000${index}`),
            },
            sizeBytes: bytes.length,
            sha256: artifactSha256(bytes),
          };
          setupArtifacts.set(part.reference.artifactId, { manifest: part, bytes });
          return part;
        });
        const splitIndexBytes = new TextEncoder().encode(
          JSON.stringify({ ...firstIndex, parts: splitParts }),
        );
        const splitRoot = {
          ...manifest.bundle,
          reference: {
            ...manifest.bundle.reference,
            artifactId: FoundryArtifactId.make("99999999-9999-4999-8999-000000000009"),
          },
          sizeBytes: splitIndexBytes.length,
          sha256: artifactSha256(splitIndexBytes),
        };
        setupArtifacts.set(splitRoot.reference.artifactId, {
          manifest: splitRoot,
          bytes: splitIndexBytes,
        });
        const splitManifest = { ...manifest, bundle: splitRoot };
        const splitReceipt = yield* confirmation.confirm(principal, splitManifest, expected);
        for (const invalidParts of [
          [splitParts[0]!, splitParts[0]!],
          [
            {
              ...full.manifest,
              reference: {
                ...full.manifest.reference,
                owner: { ...owner, threadId: ThreadId.make("foreign-bundle-thread") },
              },
            },
          ],
        ]) {
          const invalidBytes = new TextEncoder().encode(
            JSON.stringify({ ...firstIndex, parts: invalidParts }),
          );
          const invalidRoot = {
            ...splitRoot,
            sizeBytes: invalidBytes.length,
            sha256: artifactSha256(invalidBytes),
          };
          setupArtifacts.set(invalidRoot.reference.artifactId, {
            manifest: invalidRoot,
            bytes: invalidBytes,
          });
          assert.equal(
            (yield* confirmation
              .confirm(principal, { ...manifest, bundle: invalidRoot }, expected)
              .pipe(Effect.flip)).code,
            "foreign_archive",
          );
        }
        setupArtifacts.set(splitRoot.reference.artifactId, {
          manifest: splitRoot,
          bytes: splitIndexBytes,
        });

        const missingSplit = setupArtifacts.get(splitParts[1]!.reference.artifactId)!;
        setupArtifacts.delete(splitParts[1]!.reference.artifactId);
        assert.equal(
          (yield* confirmation.confirm(principal, splitManifest, expected).pipe(Effect.flip)).code,
          "unavailable",
        );
        setupArtifacts.set(splitParts[1]!.reference.artifactId, missingSplit);
        split[1]![0] = split[1]![0]! ^ 1;
        assert.equal(
          (yield* confirmation.confirm(principal, splitManifest, expected).pipe(Effect.flip)).code,
          "changed",
        );
        split[1]![0] = split[1]![0]! ^ 1;
        const environmentExpected = {
          ...expected,
          environmentId: owner.environmentId,
          threadIds: [owner.threadId],
        };
        const environment = yield* confirmation.confirmEnvironment(
          principal,
          [manifest],
          environmentExpected,
        );
        assert.deepEqual(environment.threads, [receipt]);
        lateBatchCursor = 1;
        assert.equal(
          (yield* confirmation
            .confirmEnvironment(principal, [manifest], environmentExpected)
            .pipe(Effect.flip)).code,
          "incomplete",
        );
        lateBatchCursor = 0;
        status = { ...status, confirmedCursor: 3, sourceHead: 3 };

        assert.equal(
          (yield* confirmation
            .confirmEnvironment(principal, [manifest], {
              ...environmentExpected,
              threadIds: [owner.threadId, ThreadId.make("missing")],
            })
            .pipe(Effect.flip)).code,
          "incomplete",
        );
        unlistedThread = true;
        assert.equal(
          (yield* confirmation
            .confirmEnvironment(principal, [manifest], environmentExpected)
            .pipe(Effect.flip)).code,
          "incomplete",
        );
        unlistedThread = false;
        const setupExpected = { ...expected, setupAdmitted: true, runtimeAdmitted: false };
        const partBytes = new TextEncoder().encode("setup-file-fixture");
        const partManifest = {
          ...manifest.bundle,
          reference: {
            ...manifest.bundle.reference,
            artifactId: FoundryArtifactId.make("11111111-1111-4111-8111-111111111111"),
          },
          sizeBytes: partBytes.byteLength,
          sha256: artifactSha256(partBytes),
        };
        bulkSetupArtifacts.add(partManifest.reference.artifactId);
        const indexBytes = new TextEncoder().encode(
          yield* encodeSetupIndex({ format: "foundry-setup-snapshot-2", parts: [partManifest] }),
        );
        const indexManifest = {
          ...manifest.bundle,
          reference: {
            ...manifest.bundle.reference,
            artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
          },
          sizeBytes: indexBytes.byteLength,
          sha256: artifactSha256(indexBytes),
        };
        setupArtifacts.set(indexManifest.reference.artifactId, {
          manifest: indexManifest,
          bytes: indexBytes,
        });
        const setupArchive = {
          allocationId: input.allocationId,
          fence: 1,
          kind: "setup" as const,
          artifact: indexManifest,
        };
        assert.equal(
          (yield* confirmation
            .confirmSetup(principal, setupArchive, setupExpected)
            .pipe(Effect.flip)).code,
          "unavailable",
        );
        setupArtifacts.set(partManifest.reference.artifactId, {
          manifest: partManifest,
          bytes: partBytes,
        });
        const setupReceipt = yield* confirmation.confirmSetup(
          principal,
          setupArchive,
          setupExpected,
        );
        assert.deepEqual(setupReceipt.archive, setupArchive);
        setupArtifacts.set(partManifest.reference.artifactId, {
          manifest: partManifest,
          bytes: new TextEncoder().encode("tampered"),
        });
        assert.equal(
          (yield* confirmation
            .confirmSetup(principal, setupArchive, setupExpected)
            .pipe(Effect.flip)).code,
          "unavailable",
        );
        setupArtifacts.set(partManifest.reference.artifactId, {
          manifest: partManifest,
          bytes: partBytes,
        });
        assert.equal(
          (yield* confirmation
            .confirmSetup(principal, setupArchive, { ...setupExpected, runtimeAdmitted: true })
            .pipe(Effect.flip)).code,
          "foreign_archive",
        );
        const readyWithoutThreads = yield* confirmation.confirmSetup(principal, setupArchive, {
          ...setupExpected,
          runtimeAdmitted: true,
          snapshotThreadIds: [],
          environmentId: EnvironmentId.make("empty-environment"),
        });
        assert.deepEqual(readyWithoutThreads.archive, setupArchive);
        assert.equal(
          (yield* confirmation
            .confirmSetup(principal, setupArchive, {
              ...setupExpected,
              runtimeAdmitted: true,
              snapshotThreadIds: [],
              environmentId: owner.environmentId,
            })
            .pipe(Effect.flip)).code,
          "incomplete",
        );
        const emptyArchive = { allocationId: input.allocationId, fence: 1, kind: "empty" as const };
        assert.equal(
          (yield* confirmation
            .confirmSetup(principal, emptyArchive, setupExpected)
            .pipe(Effect.flip)).code,
          "foreign_archive",
        );
        assert.deepEqual(
          (yield* confirmation.confirmSetup(principal, emptyArchive, {
            ...setupExpected,
            setupAdmitted: false,
          })).archive,
          emptyArchive,
        );
        assert.equal(
          (yield* confirmation
            .confirm(principal, manifest, { ...expected, fence: 2 })
            .pipe(Effect.flip)).code,
          "foreign_archive",
        );
        advanceDuringDownload = true;
        assert.equal(
          (yield* confirmation.confirm(principal, manifest, expected).pipe(Effect.flip)).code,
          "incomplete",
        );
        advanceDuringDownload = false;
        status = { ...status, confirmedCursor: 4, sourceHead: 4 };
        assert.equal(
          (yield* confirmation.confirm(principal, manifest, expected).pipe(Effect.flip)).code,
          "incomplete",
        );
        status = {
          ...status,
          confirmedCursor: 3,
          sourceHead: 3,
          complete: false,
          missingAttachmentCount: 1,
        };
        assert.equal(
          (yield* confirmation.confirm(principal, manifest, expected).pipe(Effect.flip)).code,
          "incomplete",
        );
        status = { ...status, complete: true, missingAttachmentCount: 0 };
        yield* fs.writeFileString(`${cwd}/new.txt`, "late writer\n");
        assert.equal((yield* service.capture(input).pipe(Effect.flip)).code, "changed");
        yield* fs.remove(cwd, { recursive: true });
        const offline = `${root}/offline`;
        yield* fs.makeDirectory(offline);
        const offlineBundle = `${root}/offline.bundle`;
        const offlineIndex = `${root}/offline-index.json`;
        yield* fs.writeFile(offlineBundle, full.bytes);
        yield* fs.writeFile(
          offlineIndex,
          setupArtifacts.get(manifest.bundle.reference.artifactId)!.bytes,
        );
        denyDownload = true;
        yield* service.restore({
          receipt,
          cwd: offline,
          bundlePath: offlineBundle,
          bundleIndexPath: offlineIndex,
        });
        denyDownload = false;
        assert.equal(yield* fs.readFileString(`${offline}/new.txt`), "untracked work\n");
        const multipartRestored = `${root}/multipart-restored`;
        yield* fs.makeDirectory(multipartRestored);
        yield* service.restore({ receipt: splitReceipt, cwd: multipartRestored });
        assert.equal(yield* fs.readFileString(`${multipartRestored}/file.txt`), "changed\n");
        const restored = `${root}/restored`;
        yield* fs.makeDirectory(restored);
        const provenance = yield* service.restore({ receipt, cwd: restored });
        assert.deepEqual(provenance.source, owner);
        assert.equal(yield* fs.readFileString(`${restored}/file.txt`), "changed\n");
        assert.equal(yield* fs.readFileString(`${restored}/new.txt`), "untracked work\n");
        assert.equal(
          (yield* git.execute({
            cwd: restored,
            operation: "sandbox.archive.test",
            args: ["rev-parse", "HEAD"],
          })).stdout.trim(),
          head,
        );
        assert.equal(
          (yield* service.restore({ receipt, cwd: restored }).pipe(Effect.flip)).code,
          "destination_not_empty",
        );
        const empty = `${root}/corrupt`;
        yield* fs.makeDirectory(empty);
        assert.equal(
          (yield* service
            .restore({ receipt: { ...receipt, digest: "0".repeat(64) }, cwd: empty })
            .pipe(Effect.flip)).code,
          "changed",
        );
        assert.isDefined(artifact);
        const bundleIndex = yield* decodeSandboxBundleIndex(manifest.bundle, artifact!.bytes);
        const firstPart = setupArtifacts.get(bundleIndex.parts[0]!.reference.artifactId)!;
        firstPart.bytes[0] = firstPart.bytes[0]! ^ 1;
        assert.equal(
          (yield* service.restore({ receipt, cwd: empty }).pipe(Effect.flip)).code,
          "changed",
        );
        firstPart.bytes[0] = firstPart.bytes[0]! ^ 1;
        const legacyManifest = { ...manifest, bundle: firstPart.manifest };
        const legacyReceipt = {
          manifest: legacyManifest,
          digest: artifactSha256(new TextEncoder().encode(stableStringify(legacyManifest))),
        };
        const legacy = `${root}/legacy`;
        yield* fs.makeDirectory(legacy);
        yield* service.restore({ receipt: legacyReceipt, cwd: legacy });
        assert.equal(yield* fs.readFileString(`${legacy}/new.txt`), "untracked work\n");
        artifact!.bytes[0] = artifact!.bytes[0]! ^ 1;
        assert.equal(
          (yield* service.restore({ receipt, cwd: empty }).pipe(Effect.flip)).code,
          "changed",
        );
        assert.deepEqual(yield* fs.readDirectory(empty), []);
        const attempt = `${root}/worktrees/attempt`;
        yield* fs.makeDirectory(`${root}/worktrees`);
        yield* git.execute({
          cwd: restored,
          operation: "sandbox.archive.test",
          args: ["worktree", "add", "--detach", attempt, "HEAD"],
        });
        yield* fs.writeFileString(`${attempt}/file.txt`, "isolated attempt changes\n");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE orchestration_events(stream_id text,aggregate_kind text,application_event_version integer)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id text,project_id text,payload_json text)`;
          yield* sql`CREATE TABLE projection_projects(project_id text,workspace_root text)`;
          yield* sql`INSERT INTO projection_projects VALUES ('project',${restored})`;
          yield* sql`INSERT INTO orchestration_events VALUES (${owner.threadId},'thread',2),('attempt-thread','thread',2)`;
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${owner.threadId},'project','{}'),('attempt-thread','project',${encodeWorkspace({ worktreePath: attempt })})`;
          const captured = yield* SandboxArchiveEnvironment.SandboxArchiveEnvironment.pipe(
            Effect.flatMap((environment) =>
              environment.capture({
                allocationId: input.allocationId,
                fence: 2,
                cwd: restored,
                attachmentsDir,
              }),
            ),
          );
          assert.equal(captured.threadIds.length, 2);
          assert.deepEqual(captured.manifests.map((value) => value.relativeWorkspacePath).sort(), [
            "restored",
            "worktrees/attempt",
          ]);
          assert.equal(new Set(captured.manifests.map((value) => value.checkpointTree)).size, 2);
          yield* fs.makeDirectory(`${root}/.foundry/private`, { recursive: true });
          for (const invalidWorkspace of [root, `${root}/.foundry/private`]) {
            yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encodeWorkspace({ worktreePath: invalidWorkspace })} WHERE thread_id='attempt-thread'`;
            assert.equal(
              (yield* SandboxArchiveEnvironment.SandboxArchiveEnvironment.pipe(
                Effect.flatMap((environment) =>
                  environment.capture({
                    allocationId: input.allocationId,
                    fence: 3,
                    cwd: restored,
                    attachmentsDir,
                  }),
                ),
                Effect.flip,
              )).code,
              "foreign_archive",
            );
          }
        }).pipe(
          Effect.provide(
            SandboxArchiveEnvironment.layer.pipe(
              Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
              Layer.provide(VcsProcess.layer),
              Layer.provide(Layer.succeed(SandboxArchive.SandboxArchive, service)),
            ),
          ),
        );
        assert.isTrue(
          bundleCreates.every((file) =>
            file.startsWith(`${config.stateDir}/foundry-sandbox-staging/bundle-`),
          ),
        );
        assert.deepEqual(yield* fs.readDirectory(`${config.stateDir}/foundry-sandbox-staging`), []);
      }).pipe(
        Effect.provide(
          Layer.merge(SandboxArchive.layer, SandboxArchive.layerConfirmation).pipe(
            Layer.provide(external),
          ),
        ),
      );
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);
