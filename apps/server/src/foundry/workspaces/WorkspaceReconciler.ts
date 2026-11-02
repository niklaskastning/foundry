import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ExecutionStore from "../ExecutionStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "../../orchestration-v2/ProviderSessionManager.ts";
import { WorkspaceGate } from "./WorkspaceGate.ts";

export class WorkspaceReconciler extends Context.Service<
  WorkspaceReconciler,
  { readonly reconcile: Effect.Effect<void> }
>()("t3/foundry/workspaces/WorkspaceReconciler") {}
export const layer = Layer.effect(
  WorkspaceReconciler,
  Effect.gen(function* () {
    const gate = yield* WorkspaceGate;
    const executions = yield* ExecutionStore.ExecutionStore;
    const threads = yield* Threads.ThreadManagementService;
    const sessions = yield* Sessions.ProviderSessionManagerV2;
    const reconcile = Effect.gen(function* () {
      for (const binding of yield* gate.bindings) {
        yield* Effect.gen(function* () {
          if (binding.commandId !== null) {
            const row = yield* executions.read(CommandId.make(binding.commandId));
            if (
              row?.generation === binding.generation &&
              row.threadId === binding.threadId &&
              row.writerEnded === 1 &&
              row.manifest !== null
            )
              yield* gate.confirm(binding.requestId);
            return;
          }
          if (!binding.runId) return;
          const records = yield* threads.getThreadRecords(ThreadId.make(binding.threadId), [
            "runs",
            "attempts",
            "providerThreads",
            "providerTurns",
          ]);
          const run = records.runs.find((run) => run.id === binding.runId);
          if (!run) return;
          const attempt = records.attempts.find((attempt) => attempt.id === binding.attemptId);
          const terminal = [
            "completed",
            "interrupted",
            "cancelled",
            "failed",
            "rolled_back",
            "superseded",
          ];
          if (
            binding.attemptId
              ? !attempt || !terminal.includes(attempt.status)
              : !terminal.includes(run.status)
          )
            return;
          const providerThread = records.providerThreads.find(
            (thread) => thread.id === (attempt?.providerThreadId ?? run.providerThreadId),
          );
          if (
            attempt?.nativeThreadId &&
            attempt.nativeThreadId !== providerThread?.nativeThreadRef?.nativeId
          )
            return;
          const turn = records.providerTurns.findLast(
            (turn) => turn.runAttemptId === (binding.attemptId ?? run.activeAttemptId),
          );
          if (!providerThread?.providerSessionId || !turn?.nativeTurnRef?.nativeId) return;
          const runtime = yield* sessions.get(providerThread.providerSessionId);
          if (Option.isNone(runtime) || !runtime.value.confirmWriterEnded) return;
          const proof = yield* runtime.value
            .confirmWriterEnded({
              runId: run.id,
              providerThread,
              nativeTurnId: turn.nativeTurnRef.nativeId,
            })
            .pipe(Effect.timeoutOption("2 seconds"));
          if (Option.isSome(proof) && proof.value) yield* gate.confirm(binding.requestId);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Workspace writer remains reserved", {
              requestId: binding.requestId,
              cause,
            }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace reconciliation failed closed", { cause }),
      ),
    );
    return { reconcile };
  }),
);
export const layerWatchdog = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconciler = yield* WorkspaceReconciler;
    const gate = yield* WorkspaceGate;
    yield* gate.installReconciler(reconciler.reconcile);
    yield* reconciler.reconcile.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  }),
).pipe(Layer.provide(layer));
