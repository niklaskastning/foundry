import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  CheckpointId,
  FoundryArtifactId,
  FoundryInstanceId,
  FoundryDeviceId,
  EnvironmentId,
  type ChatAttachment,
  type FoundryWorkerExecution,
  type FoundryWorkerHandoffOpen,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as WorkerHandoff from "./WorkerHandoff.ts";
import * as WorkerLaunch from "./WorkerLaunch.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Checkpoints from "../checkpointing/CheckpointStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import * as Gate from "./workspaces/WorkspaceGate.ts";
import * as Reservations from "./workspaces/WorkspaceReservations.ts";
import * as ReservationStore from "./workspaces/ReservationStore.ts";
import * as Stop from "./workspaces/WriterStopVerifier.ts";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const encodeRoots = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const infrastructure = Git.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "p51-handoff-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.fn("test.handoff.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const temp = yield* fs.makeTempDirectoryScoped();
  const root = `${temp}/managed`;
  const cwd = `${root}/project`;
  yield* fs.makeDirectory(cwd, { recursive: true });
  const command = Effect.fn("test.handoff.git")(function* (
    at: string,
    args: ReadonlyArray<string>,
  ) {
    return (yield* git.execute({ cwd: at, operation: "test.handoff", args })).stdout.trim();
  });
  yield* command(cwd, ["init"]);
  yield* fs.writeFileString(`${cwd}/task.txt`, "original");
  yield* command(cwd, ["add", "."]);
  yield* command(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const base = yield* command(cwd, ["rev-parse", "HEAD"]);
  const sourceRef = "refs/t3/test-source";
  yield* command(cwd, ["update-ref", sourceRef, base]);
  const projectId = ProjectId.make("handoff-project");
  const sourceId = ThreadId.make("handoff-source");
  const runId = RunId.make("source-run");
  const checkpointId = CheckpointId.make("source-checkpoint");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
  const state = {
    ended: true,
    missingCheckpoint: false,
    archiveComplete: true,
    manualRun: false,
    manualCheckpoint: false,
    sourceAvailable: true,
  };
  const execution: FoundryWorkerExecution = {
    receipt: {
      commandId: CommandId.make("source-command"),
      threadId: sourceId,
      acceptedAt: "2026-11-05T00:00:00Z",
      sequence: 1,
    },
    run: { id: runId, status: "completed", checkpointId },
    lifecycle: {
      generation: 1,
      expiresAt: 0,
      state: "completed",
      writerEnded: true,
      manifest: {
        generation: 1,
        runId,
        checkpointId,
        checkpointRef: sourceRef,
        outcome: "completed",
      },
    },
  };
  const created = new Map<string, { projectId: ProjectId; workspace: string }>();
  const threadLayer = Layer.succeed(Threads.ThreadManagementService, {
    getThreadShell: Effect.fn("test.handoff.shell")((id: ThreadId) =>
      Effect.succeed(
        id === sourceId && !state.sourceAvailable ? null : { id, projectId, modelSelection },
      ),
    ),
    getThreadRecords: Effect.fn("test.handoff.records")((id: ThreadId) =>
      Effect.succeed({
        thread: { id, projectId, modelSelection, worktreePath: created.get(id)?.workspace ?? null },
        runs:
          id !== sourceId && state.manualRun
            ? [
                {
                  id: "manual-run",
                  ordinal: 1,
                  status: "completed",
                  checkpointId: "manual-checkpoint",
                },
              ]
            : [],
        checkpoints:
          id === sourceId
            ? [
                {
                  id: checkpointId,
                  ref: sourceRef,
                  status: state.missingCheckpoint ? "error" : "ready",
                  runId,
                  scopeId: "source-scope",
                },
              ]
            : state.manualCheckpoint
              ? [
                  {
                    id: "manual-checkpoint",
                    ref: sourceRef,
                    status: "ready",
                    runId: "manual-run",
                    scopeId: "manual-scope",
                  },
                ]
              : [],
        checkpointScopes:
          id === sourceId
            ? [{ id: "source-scope", runId, cwd }]
            : [{ id: "manual-scope", runId: "manual-run", cwd: created.get(id)?.workspace }],
      }),
    ),
  } as unknown as Threads.ThreadManagementService["Service"]);
  const projectLayer = Layer.succeed(Projects.ProjectService, {
    getById: Effect.fn("test.handoff.project")(() =>
      Effect.succeedSome({
        id: projectId,
        workspaceRoot: cwd,
        deletedAt: null,
        defaultModelSelection: modelSelection,
      }),
    ),
  } as unknown as Projects.ProjectService["Service"]);
  const launchLayer = Layer.succeed(ThreadLaunch.ThreadLaunchService, {
    launch: Effect.fn("test.handoff.launch")((input: ThreadLaunch.ThreadLaunchInput) =>
      Effect.sync(() => {
        assert.isUndefined(input.initialMessage);
        assert.equal(input.workspaceStrategy.type, "existing_worktree");
        if (input.workspaceStrategy.type === "existing_worktree" && input.threadId)
          created.set(input.threadId, {
            projectId: input.projectId,
            workspace: input.workspaceStrategy.worktreePath,
          });
        return {};
      }),
    ),
  } as unknown as ThreadLaunch.ThreadLaunchService["Service"]);
  const workerLayer = Layer.succeed(WorkerLaunch.WorkerLaunch, {
    read: Effect.fn("test.handoff.source")(() =>
      Effect.succeed({
        ...execution,
        lifecycle: { ...execution.lifecycle!, writerEnded: state.ended },
      }),
    ),
  } as unknown as WorkerLaunch.WorkerLaunch["Service"]);
  const checkpointLayer = Layer.succeed(Checkpoints.CheckpointStore, {
    captureCheckpoint: Effect.fn("test.handoff.capture")(
      ({ cwd: at, checkpointRef }: Checkpoints.CaptureCheckpointInput) =>
        command(at, ["update-ref", checkpointRef, "HEAD"]).pipe(Effect.asVoid, Effect.orDie),
    ),
    deleteCheckpointRefs: Effect.fn("test.handoff.delete")(
      ({ cwd: at, checkpointRefs }: Checkpoints.DeleteCheckpointRefsInput) =>
        Effect.forEach(checkpointRefs, (ref) => command(at, ["update-ref", "-d", ref]), {
          discard: true,
        }).pipe(Effect.orDie),
    ),
    diffCheckpoints: Effect.fn("test.handoff.diff")(
      ({ cwd: at, fromCheckpointRef, toCheckpointRef }: Checkpoints.DiffCheckpointsInput) =>
        command(at, ["diff", fromCheckpointRef, toCheckpointRef]).pipe(Effect.orDie),
    ),
    hasCheckpointRef: Effect.fn("test.handoff.exists")(({ cwd: at, checkpointRef }) =>
      command(at, ["rev-parse", "--verify", checkpointRef]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    ),
    isGitRepository: () => Effect.succeed(true),
    restoreCheckpoint: () => Effect.succeed(false),
    listAuthoredPaths: () => Effect.succeed(new Set()),
  });
  const artifacts = new Map<string, { manifest: FoundryArtifactManifest; bytes: Uint8Array }>();
  const instanceId = FoundryInstanceId.make("11111111-1111-4111-8111-111111111111");
  const deviceId = FoundryDeviceId.make("22222222-2222-4222-8222-222222222222");
  const environmentId = EnvironmentId.make("worker-environment");
  const publicationLayer = Layer.succeed(ArtifactPublication.ArtifactPublication, {
    publishAttachment: Effect.fn("test.handoff.publish")(function* <
      Attachment extends ChatAttachment,
    >(threadId: string, attachment: Attachment) {
      const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      assert.isNotNull(file);
      const bytes = yield* fs.readFile(file!).pipe(Effect.orDie);
      const manifest: FoundryArtifactManifest = {
        reference: {
          instanceId,
          artifactId: FoundryArtifactId.make("33333333-3333-4333-8333-333333333333"),
          owner: { environmentId, threadId: ThreadId.make(threadId) },
        },
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        sha256: artifactSha256(bytes),
      };
      artifacts.set(manifest.reference.artifactId, { manifest, bytes });
      return { ...attachment, foundryArtifact: manifest };
    }),
    download: Effect.fn("test.handoff.download")((reference) =>
      Effect.succeed(artifacts.get(reference.artifactId)!),
    ),
  });
  const archiveLayer = Layer.succeed(ArchivePublication.ArchivePublication, {
    reconcile: Effect.fn("test.handoff.archive")((threadId) =>
      Effect.succeed({
        instanceId,
        deviceId,
        deviceGeneration: 1,
        owner: { environmentId, threadId },
        confirmedCursor: 1,
        confirmedSourceSequence: 1,
        sourceHead: 1,
        sourceComplete: state.archiveComplete,
        complete: state.archiveComplete,
        missingArtifacts: [],
        missingAttachmentCount: 0,
      }),
    ),
  });
  const journal = ReservationStore.layer(`${temp}/holds.sqlite`);
  const gate = Gate.layer([root]).pipe(
    Layer.provide(
      Reservations.layer([root]).pipe(
        Layer.provide(Stop.layerBound.pipe(Layer.provide(journal))),
        Layer.provide(journal),
      ),
    ),
    Layer.provide(journal),
  );
  const rootsJson = yield* encodeRoots([root]);
  const layer = WorkerHandoff.layer.pipe(
    Layer.provideMerge(gate),
    Layer.provideMerge(journal),
    Layer.provide(
      Layer.mergeAll(
        threadLayer,
        projectLayer,
        launchLayer,
        workerLayer,
        checkpointLayer,
        publicationLayer,
        archiveLayer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              FOUNDRY_WORKER_WORKSPACE_ROOTS: rootsJson,
            },
          }),
        ),
      ),
    ),
  );
  const input: FoundryWorkerHandoffOpen = {
    commandId: CommandId.make("open"),
    handoffId: "handoff",
    factoryId: "factory",
    workItemId: "item",
    runId: "automation-run",
    source: { commandId: execution.receipt.commandId, generation: 1 },
    projectId,
    mode: "existing",
    title: "Edit work item",
  };
  return { fs, cwd, base, root, command, state, layer, input, created, artifacts, sourceId };
});

it.live(
  "returns only stopped, checkpointed and centrally confirmed work and recovers duplicate commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const service = yield* WorkerHandoff.WorkerHandoff;
        const gate = yield* Gate.WorkspaceGate;
        f.state.ended = false;
        assert.equal((yield* service.open(f.input).pipe(Effect.flip)).code, "writer_not_ended");
        f.state.ended = true;
        f.state.missingCheckpoint = true;
        assert.equal((yield* service.open(f.input).pipe(Effect.flip)).code, "checkpoint_pending");
        f.state.missingCheckpoint = false;
        const receipt = yield* service.open(f.input);
        assert.deepEqual(yield* service.open(f.input), receipt);
        assert.equal(
          (yield* service.open({ ...f.input, title: "changed request" }).pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal(f.created.size, 1);
        const finish = {
          commandId: CommandId.make("finish"),
          handoffId: receipt.handoffId,
          expectedBaseCommit: receipt.baseCommit,
          tests: "manual inspection",
          openPoints: "none",
        };
        assert.equal(
          (yield* service
            .finish({
              ...finish,
              commandId: CommandId.make("wrong-base"),
              expectedBaseCommit: "a".repeat(40),
            })
            .pipe(Effect.flip)).code,
          "conflict",
        );
        f.state.manualRun = true;
        assert.equal((yield* service.finish(finish).pipe(Effect.flip)).code, "checkpoint_pending");
        assert.isFalse(
          yield* gate.handoffs!.handoffAllowed(receipt.threadId, receipt.workspacePath),
        );
        yield* service.reopen({
          commandId: CommandId.make("reopen"),
          handoffId: receipt.handoffId,
        });
        assert.deepEqual(
          yield* service.reopen({
            commandId: CommandId.make("reopen"),
            handoffId: receipt.handoffId,
          }),
          receipt,
        );
        assert.equal((yield* service.finish(finish).pipe(Effect.flip)).code, "conflict");
        f.state.manualCheckpoint = true;
        yield* f.fs.writeFileString(`${f.cwd}/task.txt`, "changed");
        assert.equal(
          (yield* service
            .finish({ ...finish, commandId: CommandId.make("dirty") })
            .pipe(Effect.flip)).code,
          "workspace_changed",
        );
        yield* service.reopen({
          commandId: CommandId.make("reopen-dirty"),
          handoffId: receipt.handoffId,
        });
        yield* f.command(f.cwd, ["add", "."]);
        yield* f.command(f.cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "manual change",
        ]);
        f.state.archiveComplete = false;
        const last = { ...finish, commandId: CommandId.make("final") };
        assert.equal((yield* service.finish(last).pipe(Effect.flip)).code, "archive_missing");
        f.state.archiveComplete = true;
        const result = yield* service.finish(last);
        assert.notEqual(result.commitSha, f.base);
        assert.equal(result.bundle.sha256.length, 64);
        assert.deepEqual(yield* service.finish(last), result);
        assert.equal(
          (yield* service
            .reopen({ commandId: CommandId.make("late-reopen"), handoffId: receipt.handoffId })
            .pipe(Effect.flip)).code,
          "conflict",
        );
        assert.isFalse(
          yield* gate.handoffs!.handoffAllowed(receipt.threadId, receipt.workspacePath),
        );
      }).pipe(Effect.provide(f.layer), Effect.scoped);
      yield* Effect.gen(function* () {
        const service = yield* WorkerHandoff.WorkerHandoff;
        assert.equal((yield* service.open(f.input)).baseCommit, f.base);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live(
  "branches from the pinned source and restores only a confirmed bundle into a fresh workspace",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const service = yield* WorkerHandoff.WorkerHandoff;
        const input = { ...f.input, mode: "branch" as const };
        const receipt = yield* service.open(input);
        assert.notEqual(receipt.workspacePath, f.cwd);
        assert.equal(yield* f.command(receipt.workspacePath, ["rev-parse", "HEAD"]), f.base);
        yield* f.fs.writeFileString(`${receipt.workspacePath}/task.txt`, "branch change");
        yield* f.command(receipt.workspacePath, ["add", "."]);
        yield* f.command(receipt.workspacePath, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "branch change",
        ]);
        const returned = yield* service.finish({
          commandId: CommandId.make("return-branch"),
          handoffId: receipt.handoffId,
          expectedBaseCommit: receipt.baseCommit,
          tests: "inspection",
          openPoints: "",
        });
        assert.equal(yield* f.fs.readFileString(`${f.cwd}/task.txt`), "original");
        const recovery = {
          ...f.input,
          commandId: CommandId.make("recover"),
          handoffId: "recovery",
          mode: "archive" as const,
        };
        assert.equal((yield* service.open(recovery).pipe(Effect.flip)).code, "archive_missing");
        yield* f.fs.remove(f.cwd, { recursive: true });
        f.state.sourceAvailable = false;
        const restored = yield* service.open({
          ...recovery,
          commandId: CommandId.make("recover-bundle"),
          archive: {
            bundle: returned.bundle,
            commitSha: returned.commitSha,
            treeSha: returned.treeSha,
            sourceThreadId: receipt.threadId,
          },
        });
        assert.notEqual(restored.workspacePath, receipt.workspacePath);
        assert.equal(
          yield* f.fs.readFileString(`${restored.workspacePath}/task.txt`),
          "branch change",
        );
        assert.equal(
          yield* f.command(restored.workspacePath, ["rev-parse", "HEAD"]),
          returned.commitSha,
        );
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);
