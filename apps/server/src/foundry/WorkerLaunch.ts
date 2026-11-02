import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { WorkerReadiness } from "./WorkerReadiness.ts";

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(FoundryWorkerManifest));
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
      `foundry-launch:${digest(JSON.stringify([1, key, binding, input.projectId, input.title, input.model, input.prompt]))}`,
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
    const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
    const executions = yield* ExecutionStore.ExecutionStore;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
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
            (candidate) => candidate.runAttemptId === run.activeAttemptId,
          );
          const turn = turns.at(-1);
          if (
            run.activeAttemptId &&
            providerThread?.providerSessionId &&
            turn?.nativeTurnRef?.nativeId
          ) {
            const runtime = yield* sessions.get(providerThread.providerSessionId);
            if (
              Option.isSome(runtime) &&
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
            yield* executions.finish(input.commandId, row.generation, {
              generation: row.generation,
              runId: run.id,
              checkpointId: ready ? checkpoint.id : null,
              checkpointRef: ready ? checkpoint.ref : null,
              outcome: stopped ? "stopped" : "completed",
            });
            row = yield* executions.read(input.commandId);
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
        const execution = yield* read({ commandId: input.launchCommandId });
        const commandId = CommandId.make(`foundry-cancel:${digest(input.commandId)}`);
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
    );
    if (enabled) {
      yield* Effect.gen(function* () {
        const pending = yield* executions.sweep;
        yield* Effect.forEach(
          pending,
          (row) =>
            Effect.gen(function* () {
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
          const workspace = yield* fs
            .realPath(project.value.workspaceRoot)
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
          yield* executions.reserve(input.commandId, ids.threadId);
          yield* launches.launch({
            ...ids,
            projectId: input.projectId,
            title: input.title,
            modelSelection: { instanceId: ProviderInstanceId.make(binding), model: input.model },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text: input.prompt, attachments: [] },
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
      ),
    };
  }),
);
