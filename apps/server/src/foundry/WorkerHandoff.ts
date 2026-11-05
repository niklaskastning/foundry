// @effect-diagnostics nodeBuiltinImport:off -- Stable IDs bind retries to one worker workspace and thread.
import * as NodeCrypto from "node:crypto";
import {
  ChatAttachmentId,
  type ChatFileAttachment,
  CheckpointRef,
  CommandId,
  ThreadId,
  FoundryWorkspaceError,
  FoundryWorkerHandoffError,
  FoundryWorkerHandoffOpen,
  FoundryWorkerHandoffFinish,
  FoundryWorkerHandoffReopen,
  FoundryWorkerHandoffReceipt,
  FoundryWorkerHandoffResult,
  ModelSelection,
  FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Checkpoints from "../checkpointing/CheckpointStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as WorkerLaunch from "./WorkerLaunch.ts";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ArchivePublication from "./ArchivePublication.ts";
import { WorkspaceGate } from "./workspaces/WorkspaceGate.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

interface Service {
  readonly open: (
    input: FoundryWorkerHandoffOpen,
  ) => Effect.Effect<FoundryWorkerHandoffReceipt, FoundryWorkerHandoffError>;
  readonly finish: (
    input: FoundryWorkerHandoffFinish,
  ) => Effect.Effect<FoundryWorkerHandoffResult, FoundryWorkerHandoffError>;
  readonly reopen: (
    input: FoundryWorkerHandoffReopen,
  ) => Effect.Effect<FoundryWorkerHandoffReceipt, FoundryWorkerHandoffError>;
}
const disabled: Service = {
  open: Effect.fn("WorkerHandoff.disabledOpen")(() =>
    Effect.fail(new FoundryWorkerHandoffError({ code: "not_enabled" })),
  ),
  finish: Effect.fn("WorkerHandoff.disabledFinish")(() =>
    Effect.fail(new FoundryWorkerHandoffError({ code: "not_enabled" })),
  ),
  reopen: Effect.fn("WorkerHandoff.disabledReopen")(() =>
    Effect.fail(new FoundryWorkerHandoffError({ code: "not_enabled" })),
  ),
};
export class WorkerHandoff extends Context.Reference<Service>("t3/foundry/WorkerHandoff", {
  defaultValue: () => disabled,
}) {}
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (code: FoundryWorkerHandoffError["code"]) => new FoundryWorkerHandoffError({ code });
const isError = Schema.is(FoundryWorkerHandoffError);
const isWorkspaceError = Schema.is(FoundryWorkspaceError);
const mapError = (error: unknown) =>
  isError(error)
    ? error
    : isWorkspaceError(error) && error.code === "request_conflict"
      ? fail("conflict")
      : fail("unavailable");
const decodeRoots = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeOpen = Schema.decodeEffect(FoundryWorkerHandoffOpen);
const decodeFinish = Schema.decodeEffect(FoundryWorkerHandoffFinish);
const decodeReopen = Schema.decodeEffect(FoundryWorkerHandoffReopen);
const decodeManifest = Schema.decodeEffect(FoundryArtifactManifest);
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(FoundryWorkerHandoffReceipt));
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(FoundryWorkerHandoffResult));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerHandoffReceipt));
const encodeOpen = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerHandoffOpen));
const encodeFinish = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerHandoffFinish));
const encodeReopen = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerHandoffReopen));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(FoundryArtifactManifest));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(FoundryWorkerHandoffResult));
const Opening = Schema.Struct({
  input: FoundryWorkerHandoffOpen,
  receipt: FoundryWorkerHandoffReceipt,
  modelSelection: ModelSelection,
  sourceCwd: Schema.String,
});
const decodeOpening = Schema.decodeEffect(Schema.fromJsonString(Opening));
const encodeOpening = Schema.encodeSync(Schema.fromJsonString(Opening));
const terminal = new Set([
  "completed",
  "interrupted",
  "cancelled",
  "failed",
  "rolled_back",
  "superseded",
]);

export const layer = Layer.effect(
  WorkerHandoff,
  Effect.gen(function* () {
    const gate = yield* WorkspaceGate;
    if (!gate.handoffs) return disabled;
    const store = gate.handoffs;
    const worker = yield* WorkerLaunch.WorkerLaunch;
    const threads = yield* Threads.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const projects = yield* Projects.ProjectService;
    const checkpoints = yield* Checkpoints.CheckpointStore;
    const git = yield* Git.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const publication = yield* ArtifactPublication.ArtifactPublication;
    const archive = yield* ArchivePublication.ArchivePublication;
    const roots = yield* Effect.forEach(
      yield* decodeRoots(
        yield* Config.String("FOUNDRY_WORKER_WORKSPACE_ROOTS").pipe(Config.withDefault("[]")),
      ),
      (root) => fs.realPath(root),
    );
    const lane = yield* Semaphore.make(1);
    const runGit = Effect.fn("WorkerHandoff.git")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* git.execute({
        cwd,
        operation: "foundry.handoff",
        args: ["-c", "core.hooksPath=/dev/null", ...args],
      });
      return result.stdout.trim();
    });
    const managedRoot = (cwd: string) =>
      roots.find((root) => {
        const relative = path.relative(root, cwd);
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      });
    const validateRepository = Effect.fn("WorkerHandoff.validateRepository")(function* (
      cwd: string,
    ) {
      if ((yield* fs.realPath(cwd)) !== cwd || !managedRoot(cwd))
        return yield* fail("workspace_changed");
      if ((yield* fs.realPath(yield* runGit(cwd, ["rev-parse", "--show-toplevel"]))) !== cwd)
        return yield* fail("workspace_changed");
      const common = yield* fs.realPath(
        path.resolve(cwd, yield* runGit(cwd, ["rev-parse", "--git-common-dir"])),
      );
      if (!managedRoot(common)) return yield* fail("workspace_changed");
    });
    const readRow = Effect.fn("WorkerHandoff.readRow")(function* (id: string) {
      const row = yield* store.handoff(id);
      if (!row) return yield* fail("not_found");
      return row;
    });
    const assertUnchanged = Effect.fn("WorkerHandoff.assertUnchanged")(function* (
      receipt: FoundryWorkerHandoffReceipt,
    ) {
      yield* validateRepository(receipt.workspacePath);
      if ((yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD"])) !== receipt.baseCommit)
        return yield* fail("workspace_changed");
      const temporary = CheckpointRef.make(`refs/t3/handoff-verify/${hash(receipt.handoffId)}`);
      yield* checkpoints.captureCheckpoint({
        cwd: receipt.workspacePath,
        checkpointRef: temporary,
      });
      yield* Effect.gen(function* () {
        if (
          (yield* checkpoints.diffCheckpoints({
            cwd: receipt.workspacePath,
            fromCheckpointRef: CheckpointRef.make(receipt.baseCheckpointRef),
            toCheckpointRef: temporary,
            maxOutputBytes: 1024,
            ignoreWhitespace: false,
          })).length
        )
          return yield* fail("workspace_changed");
      }).pipe(
        Effect.ensuring(
          checkpoints
            .deleteCheckpointRefs({ cwd: receipt.workspacePath, checkpointRefs: [temporary] })
            .pipe(Effect.ignore),
        ),
      );
    });
    const open = Effect.fn("WorkerHandoff.open")(
      function* (raw: FoundryWorkerHandoffOpen) {
        const input = yield* decodeOpen(raw);
        const command = `open:${encodeOpen(input)}`;
        const previous = yield* store.handoffCommand(input.commandId, command);
        if (previous) return yield* decodeReceipt(previous);
        let row = yield* store.handoff(input.handoffId);
        if (!row) {
          const project = yield* projects.getById(input.projectId);
          if (Option.isNone(project) || project.value.deletedAt !== null)
            return yield* fail("not_found");
          if (!path.isAbsolute(project.value.workspaceRoot))
            return yield* fail("workspace_changed");
          const projectRoot =
            input.mode === "archive"
              ? path.normalize(project.value.workspaceRoot)
              : yield* fs.realPath(project.value.workspaceRoot);
          const root = managedRoot(projectRoot);
          if (!root || (root === projectRoot && input.mode !== "existing"))
            return yield* fail("workspace_changed");
          const execution = yield* worker
            .read({ commandId: input.source.commandId })
            .pipe(Effect.orElseSucceed(() => null));
          let sourceThreadId: ThreadId;
          let sourceCwd: string;
          let baseCommit: string;
          let baseCheckpointRef: string;
          let modelSelection = project.value.defaultModelSelection;
          if (input.mode === "archive") {
            if (
              !input.archive ||
              !publication ||
              input.archive.bundle.reference.owner.threadId !== input.archive.sourceThreadId
            )
              return yield* fail("archive_missing");
            if (
              execution &&
              (!execution.lifecycle?.writerEnded ||
                execution.lifecycle.generation !== input.source.generation)
            )
              return yield* fail("writer_not_ended");
            sourceThreadId = input.archive.sourceThreadId;
            sourceCwd = projectRoot;
            baseCommit = input.archive.commitSha;
            baseCheckpointRef = input.archive.commitSha;
            const source = yield* threads
              .getThreadShell(sourceThreadId)
              .pipe(Effect.orElseSucceed(() => null));
            modelSelection = source?.modelSelection ?? modelSelection;
          } else {
            if (
              !execution?.lifecycle?.writerEnded ||
              execution.lifecycle.generation !== input.source.generation
            )
              return yield* fail("writer_not_ended");
            const manifest = execution.lifecycle.manifest;
            if (
              !manifest?.checkpointRef ||
              !manifest.checkpointId ||
              manifest.generation !== input.source.generation ||
              manifest.runId !== execution.run.id ||
              manifest.checkpointId !== execution.run.checkpointId
            )
              return yield* fail("checkpoint_pending");
            const records = yield* threads.getThreadRecords(execution.receipt.threadId, [
              "checkpoints",
              "checkpointScopes",
            ]);
            const checkpoint = records.checkpoints.find(
              (item) =>
                item.id === manifest.checkpointId &&
                item.ref === manifest.checkpointRef &&
                item.status === "ready" &&
                item.runId === manifest.runId,
            );
            const scope = records.checkpointScopes.find(
              (item) => item.id === checkpoint?.scopeId && item.runId === manifest.runId,
            );
            if (
              !checkpoint ||
              !scope ||
              scope.nodeId !== checkpoint.nodeId ||
              records.thread.projectId !== input.projectId
            )
              return yield* fail("checkpoint_pending");
            sourceCwd = yield* fs.realPath(scope.cwd);
            yield* validateRepository(sourceCwd);
            sourceThreadId = execution.receipt.threadId;
            baseCheckpointRef = manifest.checkpointRef;
            baseCommit = yield* runGit(sourceCwd, [
              "rev-parse",
              input.mode === "branch" ? manifest.checkpointRef : "HEAD",
            ]);
            modelSelection = records.thread.modelSelection;
          }
          if (!modelSelection) return yield* fail("unavailable");
          const key = hash(input.handoffId);
          const receipt: FoundryWorkerHandoffReceipt = {
            handoffId: input.handoffId,
            threadId: ThreadId.make(`foundry-handoff:${key}`),
            projectId: input.projectId,
            workspacePath:
              input.mode === "existing" ? sourceCwd : path.join(root, `handoff-${key}`),
            branch:
              input.mode === "existing"
                ? (yield* runGit(sourceCwd, ["branch", "--show-current"])) || null
                : `foundry/handoff-${key}`,
            baseCommit,
            baseCheckpointRef,
            sourceThreadId,
            mode: input.mode,
          };
          if (input.mode !== "existing" && (yield* fs.exists(receipt.workspacePath)))
            return yield* fail("workspace_changed");
          yield* gate.reconcile;
          const payload = encodeOpening({ input, receipt, modelSelection, sourceCwd });
          if (
            !(yield* store.hold({
              id: input.handoffId,
              threadId: receipt.threadId,
              workspacePath: receipt.workspacePath,
              state: "opening",
              payload,
              receipt: null,
              result: null,
              closingCommand: null,
            }))
          )
            return yield* fail("writer_not_ended");
          row = yield* readRow(input.handoffId);
        }
        const opening = yield* decodeOpening(row.payload);
        if (encodeOpen(opening.input) !== encodeOpen(input)) return yield* fail("conflict");
        if (row.receipt) {
          yield* store.handoffCommand(input.commandId, command, row.receipt);
          return yield* decodeReceipt(row.receipt);
        }
        const { receipt } = opening;
        if (receipt.mode === "branch") {
          if (!(yield* fs.exists(receipt.workspacePath)))
            yield* git.createWorktree({
              cwd: opening.sourceCwd,
              refName: receipt.baseCommit,
              newRefName: receipt.branch!,
              path: receipt.workspacePath,
            });
          if (
            (yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD"])) !== receipt.baseCommit ||
            (yield* runGit(receipt.workspacePath, ["branch", "--show-current"])) !== receipt.branch
          )
            return yield* fail("workspace_changed");
        } else if (receipt.mode === "archive") {
          if (!input.archive || !publication) return yield* fail("archive_missing");
          if (!(yield* fs.exists(receipt.workspacePath))) {
            const downloaded = yield* publication.download(input.archive.bundle.reference);
            if (encodeManifest(downloaded.manifest) !== encodeManifest(input.archive.bundle))
              return yield* fail("archive_missing");
            const temp = yield* fs.makeTempDirectoryScoped({
              directory: path.dirname(receipt.workspacePath),
              prefix: ".handoff-restore-",
            });
            const bundlePath = path.join(temp, "source.bundle");
            yield* fs.writeFile(bundlePath, downloaded.bytes);
            const staged = path.join(temp, "workspace");
            yield* runGit(temp, ["clone", "--no-checkout", "--", bundlePath, staged]);
            yield* runGit(staged, ["checkout", "-b", receipt.branch!, receipt.baseCommit]);
            yield* fs.rename(staged, receipt.workspacePath);
          }
          if (
            (yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD"])) !== receipt.baseCommit ||
            (yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD^{tree}"])) !==
              input.archive.treeSha
          )
            return yield* fail("workspace_changed");
        }
        yield* assertUnchanged(receipt);
        yield* launches.launch({
          commandId: CommandId.make(`handoff-thread:${hash(input.handoffId)}`),
          threadId: receipt.threadId,
          projectId: receipt.projectId,
          title: input.title,
          modelSelection: opening.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: receipt.workspacePath,
            ...(receipt.branch ? { branch: receipt.branch } : {}),
          },
          createdBy: "user",
          creationSource: "server",
        });
        const encoded = encodeReceipt(receipt);
        if (
          !(yield* store.transitionHandoff(input.handoffId, "opening", "open", {
            receipt: encoded,
            command: { id: input.commandId, payload: command, result: encoded },
          }))
        )
          return yield* fail("conflict");
        yield* store.handoffCommand(input.commandId, command, encoded);
        return receipt;
      },
      Effect.scoped,
      Effect.mapError(mapError),
      lane.withPermits(1),
    );
    const finish = Effect.fn("WorkerHandoff.finish")(
      function* (raw: FoundryWorkerHandoffFinish) {
        const input = yield* decodeFinish(raw);
        const command = `finish:${encodeFinish(input)}`;
        const previous = yield* store.handoffCommand(input.commandId, command);
        if (previous) return yield* decodeResult(previous);
        let row = yield* readRow(input.handoffId);
        if (!row.receipt) return yield* fail("conflict");
        const receipt = yield* decodeReceipt(row.receipt);
        if (receipt.baseCommit !== input.expectedBaseCommit) return yield* fail("conflict");
        if (row.state === "returned") {
          if (row.closingCommand !== input.commandId || !row.result) return yield* fail("conflict");
          yield* store.handoffCommand(input.commandId, command, row.result);
          return yield* decodeResult(row.result);
        }
        if (row.state === "open") {
          if (row.closingCommand === input.commandId) return yield* fail("conflict");
          if (
            !(yield* store.transitionHandoff(input.handoffId, "open", "closing", {
              closingCommand: input.commandId,
            }))
          )
            return yield* fail("conflict");
          row = yield* readRow(input.handoffId);
        }
        if (row.state !== "closing" || row.closingCommand !== input.commandId)
          return yield* fail("conflict");
        yield* gate.reconcile;
        const records = yield* threads.getThreadRecords(receipt.threadId, [
          "runs",
          "checkpoints",
          "checkpointScopes",
        ]);
        if (
          records.thread.projectId !== receipt.projectId ||
          records.thread.worktreePath !== receipt.workspacePath
        )
          return yield* fail("workspace_changed");
        if (records.runs.some((run) => !terminal.has(run.status)))
          return yield* fail("writer_not_ended");
        for (const binding of yield* gate.bindings) {
          // Closing fences atomic native entry, so an unentered cancelled reservation has no writer.
          if (
            binding.threadId === receipt.threadId &&
            binding.runId === null &&
            binding.commandId === null
          )
            yield* gate.confirm(binding.requestId);
        }
        if ((yield* gate.bindings).some((binding) => binding.threadId === receipt.threadId))
          return yield* fail("writer_not_ended");
        const latestRun = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (latestRun) {
          const checkpoint = records.checkpoints.find(
            (item) =>
              item.id === latestRun.checkpointId &&
              item.runId === latestRun.id &&
              item.status === "ready",
          );
          const scope = records.checkpointScopes.find(
            (item) => item.id === checkpoint?.scopeId && item.runId === latestRun.id,
          );
          if (
            !checkpoint ||
            !scope ||
            scope.nodeId !== checkpoint.nodeId ||
            (yield* fs.realPath(scope.cwd)) !== receipt.workspacePath ||
            !(yield* checkpoints.hasCheckpointRef({
              cwd: receipt.workspacePath,
              checkpointRef: checkpoint.ref,
            }))
          )
            return yield* fail("checkpoint_pending");
        }
        if (!publication || !archive) return yield* fail("archive_missing");
        yield* validateRepository(receipt.workspacePath);
        if (
          yield* runGit(receipt.workspacePath, [
            "status",
            "--porcelain",
            "--untracked-files=normal",
          ])
        )
          return yield* fail("workspace_changed");
        const commitSha = yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD"]);
        const treeSha = yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD^{tree}"]);
        const checkpointRef = `refs/t3/handoff-result/${hash(input.commandId)}`;
        yield* checkpoints.captureCheckpoint({
          cwd: receipt.workspacePath,
          checkpointRef: CheckpointRef.make(checkpointRef),
        });
        if (
          (yield* runGit(receipt.workspacePath, ["rev-parse", `${checkpointRef}^{tree}`])) !==
          treeSha
        )
          return yield* fail("workspace_changed");
        const temp = yield* fs.makeTempDirectoryScoped();
        const bundlePath = path.join(temp, "result.bundle");
        yield* runGit(receipt.workspacePath, ["bundle", "create", bundlePath, "HEAD"]);
        const size = Number((yield* fs.stat(bundlePath)).size);
        if (size > 50 * 1024 * 1024) return yield* fail("unavailable");
        const id = createDeterministicAttachmentId(
          receipt.threadId,
          `handoff:${input.commandId}:${commitSha}`,
        );
        if (!id) return yield* fail("unavailable");
        const attachment: ChatFileAttachment = {
          type: "file",
          id: ChatAttachmentId.make(id),
          name: "foundry-handoff.bundle",
          mimeType: "application/octet-stream",
          sizeBytes: size,
        };
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) return yield* fail("unavailable");
        yield* fs.makeDirectory(path.dirname(attachmentPath), { recursive: true });
        yield* fs.copyFile(bundlePath, attachmentPath);
        const published = yield* publication.publishAttachment(
          receipt.threadId,
          attachment,
          `handoff:${input.commandId}`,
        );
        if (!published.foundryArtifact) return yield* fail("archive_missing");
        const bundle = yield* decodeManifest(published.foundryArtifact);
        if (bundle.reference.owner.threadId !== receipt.threadId)
          return yield* fail("archive_missing");
        const confirmed = yield* archive.reconcile(receipt.threadId);
        if (
          confirmed.owner.threadId !== receipt.threadId ||
          confirmed.instanceId !== bundle.reference.instanceId ||
          confirmed.owner.environmentId !== bundle.reference.owner.environmentId ||
          !confirmed.complete ||
          !confirmed.sourceComplete ||
          confirmed.confirmedCursor !== confirmed.sourceHead ||
          !confirmed.confirmedCursor ||
          !confirmed.confirmedSourceSequence ||
          confirmed.missingArtifacts.length ||
          confirmed.missingAttachmentCount
        )
          return yield* fail("archive_missing");
        if (
          (yield* runGit(receipt.workspacePath, ["rev-parse", "HEAD"])) !== commitSha ||
          (yield* runGit(receipt.workspacePath, [
            "status",
            "--porcelain",
            "--untracked-files=normal",
          ]))
        )
          return yield* fail("workspace_changed");
        const result: FoundryWorkerHandoffResult = {
          receipt,
          commitSha,
          treeSha,
          checkpointRef,
          bundle,
          archive: {
            instanceId: confirmed.instanceId,
            deviceId: confirmed.deviceId,
            deviceGeneration: confirmed.deviceGeneration,
            owner: confirmed.owner,
            cursor: confirmed.confirmedCursor,
            sourceSequence: confirmed.confirmedSourceSequence,
          },
          tests: input.tests,
          openPoints: input.openPoints,
        };
        const encoded = encodeResult(result);
        if (
          !(yield* store.transitionHandoff(input.handoffId, "closing", "returned", {
            result: encoded,
            command: { id: input.commandId, payload: command, result: encoded },
          }))
        )
          return yield* fail("conflict");
        yield* store.handoffCommand(input.commandId, command, encoded);
        return result;
      },
      Effect.scoped,
      Effect.mapError(mapError),
      lane.withPermits(1),
    );
    const reopen = Effect.fn("WorkerHandoff.reopen")(
      function* (raw: FoundryWorkerHandoffReopen) {
        const input = yield* decodeReopen(raw);
        const command = `reopen:${encodeReopen(input)}`;
        const previous = yield* store.handoffCommand(input.commandId, command);
        if (previous) return yield* decodeReceipt(previous);
        const row = yield* readRow(input.handoffId);
        if (!row.receipt || row.state !== "closing") return yield* fail("conflict");
        if (
          !(yield* store.transitionHandoff(input.handoffId, "closing", "open", {
            command: { id: input.commandId, payload: command, result: row.receipt },
          }))
        )
          return yield* fail("conflict");
        yield* store.handoffCommand(input.commandId, command, row.receipt);
        return yield* decodeReceipt(row.receipt);
      },
      Effect.mapError(mapError),
      lane.withPermits(1),
    );
    return { open, finish, reopen } satisfies Service;
  }),
);
export const layerConfigured = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false)))
      ? layer
      : Layer.empty;
  }),
);
