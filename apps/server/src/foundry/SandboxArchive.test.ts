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
  FoundryDeviceId,
  FoundryInstanceId,
  ThreadId,
  FoundryArtifactError,
  type FoundryArtifactManifest,
  type FoundryArchiveStatus,
  type ChatAttachment,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
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
it.live(
  "confirms actual Git objects and final events, then restores dirty checkpoint files after source deletion",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
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
      let unlistedThread = false;
      let lateBatchCursor = 0;
      let artifact: { manifest: FoundryArtifactManifest; bytes: Uint8Array } | undefined;
      const unavailable = () => new FoundryArtifactError({ code: "unavailable" });
      const external = Layer.mergeAll(
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
                artifactId: FoundryArtifactId.make("c6cd2b62-1c23-4c55-8424-fcfdc52e0b02"),
              },
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: bytes.byteLength,
              sha256: artifactSha256(bytes),
            };
            artifact = { manifest, bytes };
            return { ...attachment, foundryArtifact: manifest };
          }, Effect.mapError(unavailable)),
          download: () => (artifact ? Effect.succeed(artifact) : Effect.fail(unavailable())),
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
          metadata: () => {
            if (advanceDuringDownload) status = { ...status, confirmedCursor: 4, sourceHead: 4 };
            return artifact ? Effect.succeed(artifact.manifest) : Effect.fail(unavailable());
          },
          read: (_principal, input) =>
            artifact
              ? Effect.succeed({
                  offset: input.offset,
                  total: artifact.bytes.length,
                  fileSha256: artifact.manifest.sha256,
                  sha256: artifactSha256(artifact.bytes),
                  data: Base64.encode(artifact.bytes),
                })
              : Effect.fail(unavailable()),
          begin: () => Effect.die("Unexpected begin"),
          status: () => Effect.die("Unexpected status"),
          write: () => Effect.die("Unexpected write"),
          publish: () => Effect.die("Unexpected publish"),
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
        assert.equal(manifest.checkpointTree, tree);
        assert.deepEqual(yield* service.capture(input), manifest);
        const expected = { allocationId: input.allocationId, fence: 1, owner };
        const receipt = yield* confirmation.confirm(principal, manifest, expected);
        assert.deepEqual(yield* confirmation.confirm(principal, manifest, expected), receipt);
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
        const setupArchive = {
          allocationId: input.allocationId,
          fence: 1,
          kind: "setup" as const,
          artifact: manifest.bundle,
        };
        const setupReceipt = yield* confirmation.confirmSetup(
          principal,
          setupArchive,
          setupExpected,
        );
        assert.deepEqual(setupReceipt.archive, setupArchive);
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
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=${encodeWorkspace({ worktreePath: root })} WHERE thread_id='attempt-thread'`;
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
        }).pipe(
          Effect.provide(
            SandboxArchiveEnvironment.layer.pipe(
              Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
              Layer.provide(VcsProcess.layer),
              Layer.provide(Layer.succeed(SandboxArchive.SandboxArchive, service)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.merge(SandboxArchive.layer, SandboxArchive.layerConfirmation).pipe(
            Layer.provide(external),
          ),
        ),
      );
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);
