import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { FoundryWorkerHandoffResult } from "@t3tools/contracts";
import * as WorkerPublishEvidence from "./WorkerPublishEvidence.ts";
import { FoundryPublishRequest } from "@t3tools/contracts";
import { WorkspaceGate } from "./workspaces/WorkspaceGate.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ExecutionStore from "./ExecutionStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Schedule from "effect/Schedule";
import {
  FoundryWorkerRenewError,
  FoundryWorkerManifest,
  type FoundryWorkerRenewInput,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off -- Stable digests isolate worker command keys from ordinary T3 commands.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  CheckpointRef,
  ChatAttachmentId,
  ChatFileAttachment,
  ThreadId,
  ProviderInstanceId,
  type FoundryWorkerLaunchInput,
  type FoundryWorkerLaunchReceipt,
  FoundryWorkerLaunchError,
  FoundryWorkerReadError,
  FoundryWorkerCancelError,
  type FoundryWorkerCancelInput,
  type FoundryWorkerCancellation,
  FoundryWorkerFollowError,
  type FoundryWorkerFollowInput,
  type FoundryWorkerProgress,
  type FoundryWorkerReadInput,
  type FoundryWorkerExecution,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { WorkerReadiness } from "./WorkerReadiness.ts";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import * as ServerConfig from "../config.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

const decodeHandoffResult = Schema.decodeEffect(Schema.fromJsonString(FoundryWorkerHandoffResult));
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(FoundryWorkerManifest));
const decodeFileAttachment = Schema.decodeEffect(ChatFileAttachment);
const decodeRoots = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const isCancelError = Schema.is(FoundryWorkerCancelError);
const isFollowError = Schema.is(FoundryWorkerFollowError);
const isReadError = Schema.is(FoundryWorkerReadError);
const isLaunchError = Schema.is(FoundryWorkerLaunchError);
const readFailure = (code: FoundryWorkerReadError["code"]) => new FoundryWorkerReadError({ code });
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
export function workerLaunchIds(input: FoundryWorkerLaunchInput, binding: string) {
  const key = digest(input.commandId);
  return {
    commandId: CommandId.make(`foundry-launch:${key}`),
    threadId: ThreadId.make(
      `foundry-launch:${digest(JSON.stringify([1, key, binding, input.projectId, input.title, input.model, input.prompt, ...(input.options ? [input.options] : []), ...(input.workspaceMode === "worktree" ? ["worktree"] : []), ...(input.workspaceRevision ? [input.workspaceRevision] : []), ...(input.previousExecution ? [input.previousExecution.commandId, input.previousExecution.generation] : []), ...(input.previousHandoff ? [input.previousHandoff.handoffId, input.previousHandoff.commitSha] : []), ...(input.publishEvidence ? [input.publishEvidence] : []), ...(input.inputArtifacts?.length ? [input.inputArtifacts.map((item) => [item.reference.instanceId, item.reference.artifactId, item.reference.owner.environmentId, item.reference.owner.threadId, item.name, item.mimeType, item.sizeBytes, item.sha256])] : [])]))}`,
    ),
  };
}
const failure = (code: FoundryWorkerLaunchError["code"]) => new FoundryWorkerLaunchError({ code });
export class WorkerLaunch extends Context.Service<
  WorkerLaunch,
  {
    readonly renew: (
      input: FoundryWorkerRenewInput,
    ) => Effect.Effect<void, FoundryWorkerRenewError>;
    readonly cancel: (
      input: FoundryWorkerCancelInput,
    ) => Effect.Effect<FoundryWorkerCancellation, FoundryWorkerCancelError>;
    readonly follow: (
      input: FoundryWorkerFollowInput,
    ) => Stream.Stream<FoundryWorkerProgress, FoundryWorkerFollowError>;
    readonly read: (
      input: FoundryWorkerReadInput,
    ) => Effect.Effect<FoundryWorkerExecution, FoundryWorkerReadError>;
    readonly launch: (
      input: FoundryWorkerLaunchInput,
    ) => Effect.Effect<FoundryWorkerLaunchReceipt, FoundryWorkerLaunchError>;
  }
>()("t3/foundry/WorkerLaunch") {}

export const layer = Layer.effect(
  WorkerLaunch,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("FOUNDRY_WORKER_ENABLED").pipe(Config.withDefault(false));
    const binding = yield* Config.String("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID").pipe(
      Config.withDefault(""),
    );
    const rootsJson = yield* Config.String("FOUNDRY_WORKER_WORKSPACE_ROOTS").pipe(
      Config.withDefault("[]"),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const managed = yield* ManagedProjectFolders.ManagedProjectFolders;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const eventsStore = yield* EventStore.EventStoreV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const readiness = yield* WorkerReadiness;
    const workspaceGate = yield* WorkspaceGate;
    const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const executions = yield* ExecutionStore.ExecutionStore;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const handoffs = yield* Semaphore.make(1);
    const launchLane = yield* Semaphore.make(1);
    const evidenceLane = yield* Semaphore.make(1);
    const publication = yield* ArtifactPublication.ArtifactPublication;
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const renew = Effect.fn("WorkerLaunch.renew")(
      function* (input: FoundryWorkerRenewInput) {
        if (!enabled) return yield* new FoundryWorkerRenewError({ code: "not_enabled" });
        if (!(yield* executions.renew(input.commandId, input.generation)))
          return yield* new FoundryWorkerRenewError({ code: "stale_lease" });
      },
      Effect.mapError((error) =>
        error._tag === "FoundryWorkerRenewError"
          ? error
          : new FoundryWorkerRenewError({ code: "renew_failed" }),
      ),
    );

    const read = Effect.fn("WorkerLaunch.read")(
      function* (input: FoundryWorkerReadInput) {
        if (!enabled) return yield* readFailure("not_enabled");
        const commandId = CommandId.make(`foundry-launch:${digest(input.commandId)}`);
        const initial = yield* receipts.getByCommandId(commandId);
        const messageKey = CommandId.make(`${commandId}:initial-message`);
        const accepted = yield* receipts.getByCommandId(messageKey);
        if (Option.isNone(initial) || Option.isNone(accepted))
          return yield* readFailure("not_found");
        if (
          initial.value.commandType !== "thread.create" ||
          initial.value.status !== "accepted" ||
          accepted.value.commandType !== "message.dispatch" ||
          accepted.value.status !== "accepted" ||
          initial.value.threadId !== accepted.value.threadId ||
          initial.value.resultSequence >= accepted.value.resultSequence
        )
          return yield* readFailure("read_failed");
        const receipt = accepted.value;
        const events = yield* eventsStore.readByCommandId({ commandId: messageKey }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.created" &&
              stored.event.threadId === receipt.threadId &&
              stored.sequence > initial.value.resultSequence &&
              stored.sequence <= receipt.resultSequence,
          ),
          Stream.runCollect,
        );
        const event = events.length === 1 ? events[0]?.event : undefined;
        if (event?.type !== "run.created") return yield* readFailure("read_failed");
        const records = yield* threads.getThreadRecords(
          receipt.threadId,
          ["runs", "checkpoints", "checkpointScopes", "providerThreads", "providerTurns"],
          {
            runIds: [event.payload.id],
          },
        );
        const run = records.runs.find((candidate) => candidate.id === event.payload.id);
        if (!run) return yield* readFailure("read_failed");
        let row = yield* executions.read(input.commandId);
        if (
          row &&
          row.writerEnded === 0 &&
          !["queued", "preparing", "starting", "running", "waiting"].includes(run.status)
        ) {
          const providerThread = records.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          );
          const turns = records.providerTurns.filter(
            (candidate) =>
              candidate.runAttemptId === run.activeAttemptId &&
              candidate.providerThreadId === providerThread?.id,
          );
          const turn = turns.at(-1);
          if (
            run.activeAttemptId &&
            providerThread?.providerSessionId &&
            turn?.nativeTurnRef?.nativeId
          ) {
            let runtime = yield* sessions.get(providerThread.providerSessionId);
            const providerSessionId = providerThread.providerSessionId;
            const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
            if (
              Option.isNone(runtime) &&
              row.state === "uncertain" &&
              row.stopRequested === 1 &&
              providerThread.driver === "codex" &&
              nativeThreadId &&
              providerThread.providerInstanceId === binding &&
              run.modelSelection.instanceId === providerThread.providerInstanceId
            ) {
              // Opening the harness permits native history reads; never resume the crashed thread or turn.
              runtime = yield* Effect.gen(function* () {
                const policy = yield* runtimePolicy.resolve({
                  thread: records.thread,
                  modelSelection: run.modelSelection,
                });
                return yield* sessions.open({
                  threadId: receipt.threadId,
                  providerSessionId,
                  modelSelection: run.modelSelection,
                  runtimePolicy: policy,
                  initialNativeThreadId: nativeThreadId,
                });
              }).pipe(
                Effect.timeoutOption("10 seconds"),
                Effect.orElseSucceed(() => Option.none()),
              );
            }
            if (
              Option.isSome(runtime) &&
              runtime.value.instanceId === providerThread.providerInstanceId &&
              runtime.value.driver === providerThread.driver &&
              runtime.value.confirmWriterEnded &&
              (yield* runtime.value
                .confirmWriterEnded({
                  runId: run.id,
                  providerThread,
                  nativeTurnId: turn.nativeTurnRef.nativeId,
                })
                .pipe(
                  Effect.timeoutOption("2 seconds"),
                  Effect.map((result) => Option.isSome(result) && result.value),
                ))
            ) {
              yield* executions.confirm(input.commandId, row.generation);
              row = yield* executions.read(input.commandId);
            }
          }
        }
        if (
          row?.writerEnded === 1 &&
          row.manifest === null &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)
        ) {
          const checkpoint = records.checkpoints.find(
            (candidate) =>
              candidate.id === run.checkpointId &&
              candidate.runId === run.id &&
              candidate.threadId === receipt.threadId &&
              candidate.status === "ready",
          );
          const scope = records.checkpointScopes.find(
            (candidate) =>
              candidate.id === checkpoint?.scopeId &&
              candidate.threadId === receipt.threadId &&
              candidate.runId === run.id &&
              candidate.nodeId === checkpoint?.nodeId,
          );
          const ready =
            checkpoint &&
            scope &&
            (yield* checkpoints
              .hasCheckpointRef({ cwd: scope.cwd, checkpointRef: checkpoint.ref })
              .pipe(Effect.orElseSucceed(() => false)));
          const stopped = row.stopRequested === 1 || run.status !== "completed";
          if (ready || stopped) {
            yield* evidenceLane
              .withPermit(
                Effect.gen(function* () {
                  const latest = yield* executions.read(input.commandId);
                  if (!latest || latest.manifest !== null) {
                    row = latest;
                    return;
                  }
                  const publishRequest =
                    config._tag === "Some"
                      ? yield* WorkerPublishEvidence.readRequest(
                          config.value.stateDir,
                          input.commandId,
                          FoundryPublishRequest,
                        )
                      : null;
                  const publishResult =
                    ready && !stopped && publishRequest && config._tag === "Some"
                      ? yield* WorkerPublishEvidence.capture({
                          cwd: scope.cwd,
                          checkpointRef: checkpoint.ref,
                          request: publishRequest,
                          commandId: input.commandId,
                          threadId: receipt.threadId,
                          attachmentsDir: config.value.attachmentsDir,
                        }).pipe(
                          Effect.map((publishEvidence) => ({ publishEvidence })),
                          Effect.catch((error) =>
                            Effect.succeed({
                              publishEvidenceFailure:
                                error._tag === "WorkerPublishError"
                                  ? error.reason
                                  : ("unavailable" as const),
                            }),
                          ),
                        )
                      : {};
                  yield* executions.finish(input.commandId, latest.generation, {
                    generation: latest.generation,
                    runId: run.id,
                    checkpointId: ready ? checkpoint.id : null,
                    checkpointRef: ready ? checkpoint.ref : null,
                    ...(ready ? { workspacePath: scope.cwd } : {}),
                    outcome: stopped ? "stopped" : "completed",
                    ...publishResult,
                  });
                  row = yield* executions.read(input.commandId);
                }),
              )
              .pipe(Effect.uninterruptible);
          }
        }
        const lifecycle = row
          ? {
              generation: row.generation,
              expiresAt: row.expiresAt,
              state: row.state,
              writerEnded: row.writerEnded === 1,
              manifest: row.manifest === null ? null : yield* decodeManifest(row.manifest),
            }
          : {
              generation: 0,
              expiresAt: 0,
              state: "uncertain" as const,
              writerEnded: false,
              manifest: null,
            };
        return {
          lifecycle,
          receipt: {
            commandId: input.commandId,
            threadId: receipt.threadId,
            acceptedAt: DateTime.formatIso(receipt.acceptedAt),
            sequence: receipt.resultSequence,
          },
          run: { id: run.id, status: run.status, checkpointId: run.checkpointId },
        };
      },
      Effect.mapError((error) => (isReadError(error) ? error : readFailure("read_failed"))),
    );
    const returnedHandoff = Effect.fn("WorkerLaunch.returnedHandoff")(
      function* (input: FoundryWorkerLaunchInput) {
        if (!input.previousHandoff) return null;
        if (
          input.previousExecution ||
          input.workspaceMode === "worktree" ||
          !workspaceGate.handoffs
        )
          return yield* failure("handoff_unavailable");
        const row = yield* workspaceGate.handoffs.handoff(input.previousHandoff.handoffId);
        if (!row?.result || row.state !== "returned") return yield* failure("handoff_unavailable");
        const result = yield* decodeHandoffResult(row.result);
        if (
          result.commitSha !== input.previousHandoff.commitSha ||
          result.receipt.projectId !== input.projectId ||
          result.receipt.workspacePath !== row.workspacePath
        )
          return yield* failure("handoff_changed");
        return result;
      },
      Effect.mapError((error) => (isLaunchError(error) ? error : failure("handoff_unavailable"))),
    );
    const previousWorkspace = Effect.fn("WorkerLaunch.previousWorkspace")(
      function* (input: FoundryWorkerLaunchInput) {
        if (!input.previousExecution) return null;
        const execution = yield* read({ commandId: input.previousExecution.commandId });
        const manifest = execution.lifecycle?.manifest;
        if (
          !execution.lifecycle?.writerEnded ||
          execution.lifecycle.generation !== input.previousExecution.generation ||
          !manifest?.checkpointId ||
          !manifest.checkpointRef
        )
          return yield* failure("handoff_unavailable");
        const records = yield* threads.getThreadRecords(execution.receipt.threadId, [
          "checkpoints",
          "checkpointScopes",
        ]);
        const checkpoint = records.checkpoints.find(
          (item) =>
            item.id === manifest.checkpointId &&
            item.ref === manifest.checkpointRef &&
            item.runId === execution.run.id &&
            item.status === "ready",
        );
        const scope = records.checkpointScopes.find(
          (item) => item.id === checkpoint?.scopeId && item.runId === execution.run.id,
        );
        if (!scope || records.thread.projectId !== input.projectId)
          return yield* failure("handoff_unavailable");
        return scope.cwd;
      },
      Effect.mapError((error) => (isLaunchError(error) ? error : failure("handoff_unavailable"))),
    );
    const verifyHandoff = Effect.fn("WorkerLaunch.verifyHandoff")(
      function* (input: FoundryWorkerLaunchInput, cwd: string) {
        const returned = yield* returnedHandoff(input);
        if (returned) {
          if ((yield* fs.realPath(returned.receipt.workspacePath)) !== cwd)
            return yield* failure("handoff_changed");
          if (
            (yield* git.resolveCommit({ cwd, revision: "HEAD" })).commitSha !==
              returned.commitSha ||
            (yield* git.execute({
              cwd,
              operation: "foundry.handoff.tree",
              args: ["rev-parse", "HEAD^{tree}"],
            })).stdout.trim() !== returned.treeSha
          )
            return yield* failure("handoff_changed");
          const temporary = CheckpointRef.make(
            `refs/t3/foundry-handoff/${digest(input.commandId)}`,
          );
          yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: temporary });
          yield* Effect.gen(function* () {
            const diff = yield* checkpoints.diffCheckpoints({
              cwd,
              fromCheckpointRef: CheckpointRef.make(returned.checkpointRef),
              toCheckpointRef: temporary,
              ignoreWhitespace: false,
              maxOutputBytes: 1024,
            });
            if (diff.length !== 0) return yield* failure("handoff_changed");
          }).pipe(
            Effect.ensuring(
              checkpoints
                .deleteCheckpointRefs({ cwd, checkpointRefs: [temporary] })
                .pipe(Effect.ignore),
            ),
          );
          return;
        }
        const previous = input.previousExecution;
        if (!previous) return;
        if (previous.commandId === input.commandId || input.workspaceMode === "worktree")
          return yield* failure("handoff_unavailable");
        const execution = yield* read({ commandId: previous.commandId });
        const lifecycle = execution.lifecycle;
        const manifest = lifecycle?.manifest;
        if (
          !lifecycle?.writerEnded ||
          lifecycle.generation !== previous.generation ||
          lifecycle.state !== "completed" ||
          execution.run.status !== "completed" ||
          !manifest ||
          manifest.generation !== previous.generation ||
          manifest.outcome !== "completed" ||
          manifest.runId !== execution.run.id ||
          manifest.checkpointId !== execution.run.checkpointId ||
          manifest.checkpointId === null ||
          manifest.checkpointRef === null
        )
          return yield* failure("handoff_unavailable");
        const records = yield* threads.getThreadRecords(execution.receipt.threadId, [
          "checkpoints",
          "checkpointScopes",
        ]);
        const checkpoint = records.checkpoints.find(
          (candidate) =>
            candidate.id === manifest.checkpointId &&
            candidate.runId === manifest.runId &&
            candidate.ref === manifest.checkpointRef &&
            candidate.status === "ready",
        );
        const scope = records.checkpointScopes.find(
          (candidate) =>
            candidate.id === checkpoint?.scopeId &&
            candidate.runId === manifest.runId &&
            candidate.nodeId === checkpoint?.nodeId,
        );
        if (
          !checkpoint ||
          !scope ||
          records.thread.projectId !== input.projectId ||
          (yield* fs.realPath(scope.cwd)) !== cwd ||
          !(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: checkpoint.ref }))
        )
          return yield* failure("handoff_unavailable");
        // A retry replaces and removes the same snapshot left by a crashed handoff.
        const temporary = CheckpointRef.make(`refs/t3/foundry-handoff/${digest(input.commandId)}`);
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const checked = yield* restore(
              Effect.gen(function* () {
                yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: temporary });
                const diff = yield* checkpoints.diffCheckpoints({
                  cwd,
                  fromCheckpointRef: checkpoint.ref,
                  toCheckpointRef: temporary,
                  ignoreWhitespace: false,
                  maxOutputBytes: 1024,
                });
                if (diff.length !== 0) return yield* failure("handoff_changed");
              }),
            ).pipe(Effect.exit);
            yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: [temporary] });
            return yield* Exit.match(checked, {
              onSuccess: Effect.succeed,
              onFailure: Effect.failCause,
            });
          }),
        );
      },
      Effect.mapError((error) => (isLaunchError(error) ? error : failure("handoff_unavailable"))),
      handoffs.withPermits(1),
    );
    const materializeArtifacts = Effect.fn("WorkerLaunch.materializeArtifacts")(
      function* (input: FoundryWorkerLaunchInput, threadId: ThreadId) {
        if (!input.inputArtifacts?.length) return [];
        if (!publication || Option.isNone(config)) return yield* failure("handoff_unavailable");
        const attachments: ChatFileAttachment[] = [];
        for (const expected of input.inputArtifacts) {
          const downloaded = yield* publication.download(expected.reference);
          if (
            downloaded.manifest.sha256 !== expected.sha256 ||
            downloaded.manifest.sizeBytes !== expected.sizeBytes ||
            downloaded.manifest.name !== expected.name ||
            downloaded.manifest.mimeType !== expected.mimeType ||
            downloaded.manifest.reference.instanceId !== expected.reference.instanceId ||
            downloaded.manifest.reference.artifactId !== expected.reference.artifactId ||
            downloaded.manifest.reference.owner.environmentId !==
              expected.reference.owner.environmentId ||
            downloaded.manifest.reference.owner.threadId !== expected.reference.owner.threadId
          )
            return yield* failure("handoff_changed");
          const id = createDeterministicAttachmentId(
            threadId,
            `${expected.reference.artifactId}:${expected.sha256}`,
          );
          if (!id) return yield* failure("handoff_unavailable");
          const attachment = yield* decodeFileAttachment({
            type: "file",
            id: ChatAttachmentId.make(id),
            name: expected.name,
            mimeType: expected.mimeType,
            sizeBytes: expected.sizeBytes,
          });
          const target = resolveAttachmentPath({
            attachmentsDir: config.value.attachmentsDir,
            attachment,
          });
          if (!target) return yield* failure("handoff_unavailable");
          const staged = `${target}.handoff`;
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* fs.remove(staged, { force: true });
              const written = yield* restore(
                fs
                  .writeFile(staged, downloaded.bytes, { flag: "wx", mode: 0o600 })
                  .pipe(Effect.andThen(fs.rename(staged, target))),
              ).pipe(Effect.exit);
              yield* fs.remove(staged, { force: true });
              return yield* Exit.match(written, {
                onSuccess: Effect.succeed,
                onFailure: Effect.failCause,
              });
            }),
          );
          const published = yield* publication.publishAttachment(threadId, attachment);
          if (
            !published.foundryArtifact ||
            published.foundryArtifact.sha256 !== expected.sha256 ||
            published.foundryArtifact.reference.owner.threadId !== threadId
          )
            return yield* failure("handoff_changed");
          attachments.push(published);
        }
        return attachments;
      },
      Effect.mapError((error) => (isLaunchError(error) ? error : failure("handoff_unavailable"))),
    );
    const releaseUnstarted = Effect.fn("WorkerLaunch.releaseUnstarted")(function* (
      commandId: FoundryWorkerLaunchInput["commandId"],
      threadId: ThreadId,
      generation: number,
    ) {
      const row = yield* executions.read(commandId);
      if (
        !row ||
        row.generation !== generation ||
        row.threadId !== threadId ||
        row.stopRequested !== 1 ||
        row.writerEnded !== 1 ||
        row.manifest !== null
      )
        return false;
      const launchId = CommandId.make(`foundry-launch:${digest(commandId)}`);
      if (
        Option.isSome(yield* receipts.getByCommandId(CommandId.make(`${launchId}:initial-message`)))
      )
        return false;
      const bindings = yield* workspaceGate.bindings;
      const binding = bindings.find(
        (item) =>
          item.commandId === commandId &&
          item.threadId === threadId &&
          item.generation === generation &&
          item.runId === null,
      );
      if (binding) yield* workspaceGate.confirm(binding.requestId);
      return true;
    });
    const follow = (input: FoundryWorkerFollowInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const execution = yield* read(input);
          const afterSequence = input.afterSequence ?? 0;
          const latest = yield* threads.getThreadEventSequence(execution.receipt.threadId);
          if (afterSequence > latest)
            return yield* new FoundryWorkerFollowError({ code: "invalid_cursor" });
          return threads
            .streamStoredEventsFrom({
              threadId: execution.receipt.threadId,
              afterSequence,
            })
            .pipe(
              Stream.filter((stored) =>
                stored.event.type === "run.created" || stored.event.type === "run.updated"
                  ? stored.event.payload.id === execution.run.id
                  : stored.event.type === "checkpoint.captured" &&
                    stored.event.payload.runId === execution.run.id,
              ),
              Stream.mapEffect((stored) =>
                read(input).pipe(
                  Effect.map((execution) => ({ sequence: stored.sequence, execution })),
                ),
              ),
            );
        }),
      ).pipe(
        Stream.mapError((error) => {
          if (isFollowError(error)) return error;
          return new FoundryWorkerFollowError({
            code:
              isReadError(error) && (error.code === "not_enabled" || error.code === "not_found")
                ? error.code
                : "follow_failed",
          });
        }),
      );
    const cancel = Effect.fn("WorkerLaunch.cancel")(
      function* (input: FoundryWorkerCancelInput) {
        if (!enabled) return yield* new FoundryWorkerCancelError({ code: "not_enabled" });
        const commandId = CommandId.make(`foundry-cancel:${digest(input.commandId)}`);
        const prior = yield* executions.cancellation(input.commandId);
        if (prior && prior !== input.launchCommandId)
          return yield* new FoundryWorkerCancelError({ code: "command_conflict" });
        const execution = yield* read({ commandId: input.launchCommandId }).pipe(
          Effect.catch((error) =>
            error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
        if (!execution) {
          if (Option.isSome(yield* receipts.getByCommandId(commandId)))
            return yield* new FoundryWorkerCancelError({ code: "command_conflict" });
          if (!(yield* executions.cancelUnstarted(input.commandId, input.launchCommandId)))
            return yield* new FoundryWorkerCancelError({ code: "cancel_failed" });
          const row = yield* executions.read(input.launchCommandId);
          if (row) yield* releaseUnstarted(row.commandId, row.threadId, row.generation);
          return {
            commandId: input.commandId,
            launchCommandId: input.launchCommandId,
            status: "not_started" as const,
            noStartConfirmed: true as const,
          };
        }
        const acceptedCancellation = Effect.fn("WorkerLaunch.acceptedCancellation")(function* () {
          const stored = yield* receipts.getByCommandId(commandId);
          if (Option.isNone(stored)) return Option.none();
          if (
            stored.value.status !== "accepted" ||
            stored.value.commandType !== "run.interrupt" ||
            stored.value.threadId !== execution.receipt.threadId
          )
            return yield* new FoundryWorkerCancelError({ code: "command_conflict" });
          const request = yield* eventsStore.readByCommandId({ commandId }).pipe(
            Stream.filter(
              (storedEvent) =>
                storedEvent.event.type === "turn-item.updated" &&
                storedEvent.event.payload.type === "run_interrupt_request" &&
                storedEvent.event.payload.runId === execution.run.id,
            ),
            Stream.runHead,
          );
          if (Option.isNone(request))
            return yield* new FoundryWorkerCancelError({ code: "command_conflict" });
          return Option.some({
            commandId: input.commandId,
            launch: execution.receipt,
            runId: execution.run.id,
            status: "requested" as const,
            sequence: stored.value.resultSequence,
          });
        });
        const previous = yield* acceptedCancellation();
        if (Option.isSome(previous)) return previous.value;
        yield* executions.stop(input.launchCommandId);
        const { thread } = yield* threads.getThreadRecords(execution.receipt.threadId, []);
        const result = yield* threads.interruptThread({
          commandId,
          projectId: thread.projectId,
          threadId: execution.receipt.threadId,
          runId: execution.run.id,
        });
        const accepted = yield* acceptedCancellation();
        if (Option.isSome(accepted)) return accepted.value;
        if (result.type === "already_terminal")
          return {
            commandId: input.commandId,
            launch: execution.receipt,
            runId: execution.run.id,
            status: "already_terminal" as const,
            runStatus: result.run.status,
          };
        return yield* new FoundryWorkerCancelError({ code: "cancel_failed" });
      },
      Effect.mapError((error) => {
        if (isCancelError(error)) return error;
        return new FoundryWorkerCancelError({
          code:
            isReadError(error) && (error.code === "not_enabled" || error.code === "not_found")
              ? error.code
              : error._tag === "ThreadManagementThreadNotInterruptibleError"
                ? "not_interruptible"
                : "cancel_failed",
        });
      }),
      launchLane.withPermits(1),
    );
    if (enabled) {
      yield* Effect.gen(function* () {
        const pending = yield* executions.sweep;
        yield* Effect.forEach(
          pending,
          (row) =>
            Effect.gen(function* () {
              if (
                yield* releaseUnstarted(row.commandId, row.threadId, row.generation).pipe(
                  launchLane.withPermitsIfAvailable(1),
                  Effect.map(Option.getOrElse(() => false)),
                )
              )
                return;
              const execution = yield* read({ commandId: row.commandId });
              if (row.state !== "stopping" && row.state !== "uncertain") return;
              const { thread } = yield* threads.getThreadRecords(row.threadId, []);
              yield* threads
                .interruptThread({
                  commandId: CommandId.make(`foundry-lease-stop:${row.generation}`),
                  projectId: thread.projectId,
                  threadId: row.threadId,
                  runId: execution.run.id,
                })
                .pipe(Effect.ensuring(executions.uncertain(row.commandId).pipe(Effect.ignore)));
            }).pipe(Effect.ignore),
          { discard: true },
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Foundry lease watchdog failed closed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.forkScoped,
      );
    }
    return {
      renew,
      read,
      follow,
      cancel,
      launch: Effect.fn("WorkerLaunch.launch")(
        function* (input: FoundryWorkerLaunchInput) {
          if (!enabled || !binding) return yield* failure("not_enabled");
          if (input.workspaceRevision && input.workspaceMode !== "worktree")
            return yield* failure("project_denied");
          const project = yield* projects.getById(input.projectId);
          if (
            Option.isNone(project) ||
            project.value.deletedAt !== null ||
            (yield* managed.isScratchProject(input.projectId))
          )
            return yield* failure("project_denied");
          const roots = yield* decodeRoots(rootsJson).pipe(
            Effect.mapError(() => failure("project_denied")),
          );
          const ids = workerLaunchIds(input, binding);
          const initial = yield* receipts.getByCommandId(ids.commandId);
          if (
            Option.isSome(initial) &&
            (initial.value.threadId !== ids.threadId ||
              initial.value.commandType !== "thread.create" ||
              initial.value.status !== "accepted")
          )
            return yield* failure("command_conflict");
          const messageKey = CommandId.make(`${ids.commandId}:initial-message`);
          const receipt = yield* receipts.getByCommandId(messageKey);
          const toReceipt = (
            value: CommandReceipts.CommandReceiptV2,
          ): FoundryWorkerLaunchReceipt => ({
            commandId: input.commandId,
            threadId: value.threadId,
            acceptedAt: DateTime.formatIso(value.acceptedAt),
            sequence: value.resultSequence,
          });
          if (Option.isSome(receipt)) {
            if (
              Option.isNone(initial) ||
              receipt.value.threadId !== ids.threadId ||
              receipt.value.commandType !== "message.dispatch" ||
              receipt.value.status !== "accepted"
            )
              return yield* failure("command_conflict");
            return toReceipt(receipt.value);
          }
          const returned = yield* returnedHandoff(input);
          const previousCwd = yield* previousWorkspace(input);
          const workspace = yield* fs
            .realPath(returned?.receipt.workspacePath ?? previousCwd ?? project.value.workspaceRoot)
            .pipe(Effect.mapError(() => failure("project_denied")));
          const allowed = yield* Effect.forEach(roots, (root) =>
            Effect.gen(function* () {
              if (!path.isAbsolute(root)) return false;
              const canonical = yield* fs.realPath(root);
              const relative = path.relative(canonical, workspace);
              return (
                relative === "" ||
                (!relative.startsWith(`..${path.sep}`) &&
                  relative !== ".." &&
                  !path.isAbsolute(relative))
              );
            }).pipe(Effect.orElseSucceed(() => false)),
          );
          if (!allowed.some(Boolean)) return yield* failure("project_denied");
          if (
            !(yield* threads.isProviderInstanceEnabledForProject({
              projectId: input.projectId,
              instanceId: ProviderInstanceId.make(binding),
            }))
          )
            return yield* failure("provider_disabled");
          const status = yield* readiness.read();
          if (!status.providerReady || status.providerInstanceId !== binding)
            return yield* failure("provider_not_ready");
          const model = status.models?.find(
            (model) => model.id === input.model || model.aliases.includes(input.model),
          );
          if (
            status.models &&
            (!model ||
              (input.options?.reasoningEffort &&
                !model.reasoningEfforts.includes(input.options.reasoningEffort)))
          )
            return yield* failure("provider_not_ready");
          if (input.previousExecution && input.workspaceMode === "worktree")
            return yield* failure("handoff_unavailable");
          yield* verifyHandoff(input, workspace);
          const attachments = yield* materializeArtifacts(input, ids.threadId);
          if (input.publishEvidence) {
            if (config._tag === "None") return yield* failure("launch_failed");
            yield* WorkerPublishEvidence.saveRequest(
              config.value.stateDir,
              input.commandId,
              input.publishEvidence,
            );
          }
          const execution = yield* executions
            .reserve(input.commandId, ids.threadId, status.capacity ?? 1)
            .pipe(
              Effect.mapError((error) =>
                failure(
                  error.code === "capacity_unavailable" ? "capacity_unavailable" : "launch_failed",
                ),
              ),
            );
          // Uncertain retries may recover receipts; ExecutionStore.starting still fences native entry.
          if (execution.stopRequested === 1 && execution.writerEnded === 1)
            return yield* failure("launch_failed");
          const reservation = yield* workspaceGate.reserve({
            commandId: input.commandId,
            threadId: ids.threadId,
            generation: execution.generation,
            repositoryPath: workspace,
            mode: input.workspaceMode ?? "checkout",
            ...(input.workspaceRevision ? { revision: input.workspaceRevision } : {}),
          });
          yield* verifyHandoff(input, workspace).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* executions.stop(input.commandId);
                yield* releaseUnstarted(input.commandId, ids.threadId, execution.generation);
                return yield* error;
              }),
            ),
          );
          yield* launches.launch({
            ...ids,
            projectId: input.projectId,
            title: input.title,
            modelSelection: {
              instanceId: ProviderInstanceId.make(binding),
              model: input.model,
              ...(input.options?.reasoningEffort
                ? { options: [{ id: "reasoningEffort", value: input.options.reasoningEffort }] }
                : {}),
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy:
              reservation &&
              (reservation.mode === "worktree" ||
                input.previousHandoff !== undefined ||
                previousCwd !== null)
                ? {
                    type: "existing_worktree",
                    worktreePath: reservation.workspacePath,
                    ...(reservation.branch ? { branch: reservation.branch } : {}),
                  }
                : { type: "root" },
            initialMessage: { text: input.prompt, attachments },
            createdBy: "system",
            creationSource: "server",
          });
          const accepted = yield* receipts.getByCommandId(messageKey);
          if (
            Option.isNone(accepted) ||
            accepted.value.threadId !== ids.threadId ||
            accepted.value.commandType !== "message.dispatch" ||
            accepted.value.status !== "accepted"
          )
            return yield* failure("launch_failed");
          return toReceipt(accepted.value);
        },
        Effect.mapError((error) => (isLaunchError(error) ? error : failure("launch_failed"))),
        launchLane.withPermits(1),
      ),
    };
  }),
);
