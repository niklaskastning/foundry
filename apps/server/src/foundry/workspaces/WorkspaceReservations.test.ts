import * as ConfigProvider from "effect/ConfigProvider";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Reconciler from "./WorkspaceReconciler.ts";
import * as Executions from "../ExecutionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "../../orchestration-v2/ProviderSessionManager.ts";
import { CommandId, ThreadId, RunId } from "@t3tools/contracts";
import { WorkspaceGate } from "./WorkspaceGate.ts";
import * as Gate from "./WorkspaceGate.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FoundryWorkspaceError, type FoundryWorkspaceRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ServerConfig from "../../config.ts";
import * as ReservationStore from "./ReservationStore.ts";
import * as WriterStopVerifier from "./WriterStopVerifier.ts";
import * as WorkspaceReservations from "./WorkspaceReservations.ts";

const infrastructure = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-workspaces-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.fn("test.workspace.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const temp = yield* fs.makeTempDirectoryScoped();
  const root = `${temp}/managed`;
  const repositoryPath = `${root}/repo`;
  yield* fs.makeDirectory(repositoryPath, { recursive: true });
  yield* git.execute({ cwd: repositoryPath, operation: "test.init", args: ["init"] });
  yield* fs.writeFileString(`${repositoryPath}/user.txt`, "preserve me");
  yield* git.execute({ cwd: repositoryPath, operation: "test.add", args: ["add", "."] });
  yield* git.execute({
    cwd: repositoryPath,
    operation: "test.commit",
    args: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
  });
  const request = (
    requestId: string,
    mode: "checkout" | "worktree" = "checkout",
  ): FoundryWorkspaceRequest => ({ requestId, repositoryPath, managedRoot: root, mode });
  const service = (verifier = WriterStopVerifier.layer) =>
    WorkspaceReservations.layer([root]).pipe(
      Layer.provideMerge(ReservationStore.layer(`${temp}/reservations.sqlite`)),
      Layer.provide(verifier),
    );
  return { fs, git, temp, root, repositoryPath, request, service };
});

it.live(
  "serializes checkout writers durably across service restarts and requires trusted stop evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* Effect.gen(function* () {
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        const results = yield* Effect.forEach(
          ["one", "two"],
          (id) => service.reserve(f.request(id)).pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter(Result.isSuccess).length, 1);
        const winner = results.find(Result.isSuccess)!.success;
        const loser = results.find(Result.isFailure)!.failure;
        assert.strictEqual(loser.code, "writer_busy");
        assert.deepStrictEqual(yield* service.reserve(f.request(winner.requestId)), winner);
        return winner;
      }).pipe(Effect.provide(f.service()), Effect.scoped);
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        assert.deepStrictEqual(yield* service.recover(first.requestId), first);
        assert.strictEqual(
          (yield* service.release(first.requestId).pipe(Effect.flip)).code,
          "stop_unconfirmed",
        );
        assert.strictEqual(
          (yield* service.reserve(f.request("next")).pipe(Effect.flip)).code,
          "writer_busy",
        );
        assert.strictEqual(
          (yield* service
            .reserve({ ...f.request(first.requestId), mode: "worktree" })
            .pipe(Effect.flip)).code,
          "request_conflict",
        );
      }).pipe(Effect.provide(f.service()), Effect.scoped);
      const verified = Layer.succeed(WriterStopVerifier.WriterStopVerifier, {
        confirmStopped: (reservation) =>
          reservation.requestId === first.requestId
            ? Effect.void
            : Effect.fail(new FoundryWorkspaceError({ code: "stop_unconfirmed" })),
      });
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        const released = yield* service.release(first.requestId);
        assert.strictEqual(released.state, "released");
        assert.deepStrictEqual(yield* service.release(first.requestId), released);
        assert.deepStrictEqual(yield* service.reserve(f.request(first.requestId)), released);
        assert.strictEqual((yield* service.reserve(f.request("next"))).state, "ready");
      }).pipe(Effect.provide(f.service(verified)), Effect.scoped);
      assert.strictEqual(yield* f.fs.readFileString(`${f.repositoryPath}/user.txt`), "preserve me");
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("allocates separate real Git worktrees with idempotent recovery and root boundaries", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(`${f.temp}/outside.txt`, "untouched");
    yield* f.fs.symlink(f.temp, `${f.root}/escape`);
    yield* Effect.gen(function* () {
      const service = yield* WorkspaceReservations.WorkspaceReservations;
      const reservations = yield* Effect.forEach(
        ["a", "b"],
        (id) => service.reserve(f.request(id, "worktree")),
        { concurrency: "unbounded" },
      );
      assert.notStrictEqual(reservations[0]!.workspacePath, reservations[1]!.workspacePath);
      for (const reservation of reservations) {
        assert.strictEqual(
          yield* f.fs.readFileString(`${reservation.workspacePath}/user.txt`),
          "preserve me",
        );
        assert.deepStrictEqual(
          yield* service.reserve(f.request(reservation.requestId, "worktree")),
          reservation,
        );
        assert.deepStrictEqual(yield* service.recover(reservation.requestId), reservation);
      }
      const retries = yield* Effect.forEach(
        [0, 1],
        () => service.reserve(f.request("same-request", "worktree")).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.isAtLeast(retries.filter(Result.isSuccess).length, 1);
      const repeated = yield* service.reserve(f.request("same-request", "worktree"));
      assert.strictEqual(repeated.state, "ready");
      const worktrees = yield* f.git.listWorktreePaths(f.repositoryPath);
      assert.strictEqual(worktrees.length, 4);
      assert.strictEqual(worktrees.filter((path) => path === repeated.workspacePath).length, 1);
      for (const changes of [
        { managedRoot: f.temp },
        { repositoryPath: f.temp },
        { repositoryPath: `${f.root}/escape` },
        { managedRoot: `${f.root}/../` },
      ]) {
        assert.strictEqual(
          (yield* service.reserve({ ...f.request("denied"), ...changes }).pipe(Effect.flip)).code,
          "path_denied",
        );
      }
      yield* f.fs.makeDirectory(`${f.repositoryPath}/sub`);
      assert.strictEqual(
        (yield* service
          .reserve({ ...f.request("sub"), repositoryPath: `${f.repositoryPath}/sub` })
          .pipe(Effect.flip)).code,
        "not_repository",
      );
    }).pipe(Effect.provide(f.service()), Effect.scoped);
    assert.strictEqual(yield* f.fs.readFileString(`${f.temp}/outside.txt`), "untouched");
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live(
  "recovers the allocation crash window after restart without reallocating or dropping unclear claims",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const pending = yield* Effect.gen(function* () {
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        const ready = yield* service.reserve(f.request("template", "worktree"));
        const store = yield* ReservationStore.ReservationStore;
        const pending = {
          ...ready,
          requestId: "pending",
          workspacePath: `${f.root}/pending`,
          branch: "foundry/pending",
          state: "allocating" as const,
        };
        assert.isTrue(yield* store.claim(pending));
        yield* f.git.createWorktree({
          cwd: f.repositoryPath,
          refName: pending.baseCommit,
          newRefName: pending.branch,
          path: pending.workspacePath,
        });
        assert.isTrue(
          yield* store.claim({
            ...pending,
            requestId: "missing",
            workspacePath: `${f.root}/missing`,
          }),
        );
        assert.isTrue(
          yield* store.claim({
            ...pending,
            requestId: "wrong",
            workspacePath: ready.workspacePath + "-wrong",
          }),
        );
        yield* f.git.createWorktree({
          cwd: f.repositoryPath,
          refName: pending.baseCommit,
          newRefName: "wrong-branch",
          path: ready.workspacePath + "-wrong",
        });
        return pending;
      }).pipe(Effect.provide(f.service()), Effect.scoped);
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        assert.deepStrictEqual(yield* service.recover("pending"), { ...pending, state: "ready" });
        assert.deepStrictEqual(yield* service.recover("pending"), { ...pending, state: "ready" });
        assert.strictEqual(
          (yield* service.recover("wrong").pipe(Effect.flip)).code,
          "recovery_required",
        );
        assert.strictEqual(
          (yield* service.recover("missing").pipe(Effect.flip)).code,
          "path_denied",
        );
        assert.strictEqual(
          (yield* service.release("missing").pipe(Effect.flip)).code,
          "stop_unconfirmed",
        );
        assert.strictEqual(
          (yield* service
            .reserve({ ...f.request("blocked"), repositoryPath: pending.workspacePath })
            .pipe(Effect.flip)).code,
          "writer_busy",
        );
      }).pipe(Effect.provide(f.service()), Effect.scoped);
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("enforces writer exclusion across independent journal connections", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const results = yield* Effect.forEach(
      ["connection-a", "connection-b"],
      (id) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceReservations.WorkspaceReservations;
          return yield* service.reserve(f.request(id));
        }).pipe(Effect.provide(f.service()), Effect.scoped, Effect.result),
      { concurrency: "unbounded" },
    );
    assert.strictEqual(results.filter(Result.isSuccess).length, 1);
    assert.strictEqual(results.find(Result.isFailure)!.failure.code, "writer_busy");
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("binds provider admission to a durable reservation and never reopens an ended writer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const journal = ReservationStore.layer(`${f.temp}/bound.sqlite`);
    const gateLayer = Gate.layer([f.root]).pipe(
      Layer.provide(
        WorkspaceReservations.layer([f.root]).pipe(
          Layer.provide(WriterStopVerifier.layerBound.pipe(Layer.provide(journal))),
          Layer.provide(journal),
        ),
      ),
      Layer.provideMerge(journal),
    );
    const worker = {
      commandId: "execution-one",
      threadId: "foundry-launch:one",
      generation: 7,
      repositoryPath: f.repositoryPath,
      mode: "checkout" as const,
    };
    yield* Effect.gen(function* () {
      const gate = yield* WorkspaceGate;
      const store = yield* ReservationStore.ReservationStore;
      const reserved = yield* gate.reserve(worker);
      assert.equal(reserved?.workspacePath, f.repositoryPath);
      assert.deepEqual(yield* gate.reserve(worker), reserved);
      assert.isFalse(
        yield* gate.starting({ threadId: "manual", runId: "manual-1", cwd: f.repositoryPath }),
      );
      assert.isFalse(
        yield* gate.starting({ threadId: worker.threadId, runId: "run-one", cwd: f.root }),
      );
      assert.isTrue(
        yield* gate.starting({
          threadId: worker.threadId,
          runId: "run-one",
          cwd: f.repositoryPath,
        }),
      );
      assert.isFalse(
        yield* gate.starting({
          threadId: worker.threadId,
          runId: "run-one",
          cwd: f.repositoryPath,
        }),
      );
      assert.equal((yield* store.bindings)[0]?.generation, 7);
      assert.equal((yield* store.bindings)[0]?.runId, "run-one");
    }).pipe(Effect.provide(gateLayer), Effect.scoped);
    yield* Effect.gen(function* () {
      const gate = yield* WorkspaceGate;
      assert.isFalse(
        yield* gate.starting({ threadId: "manual", runId: "manual-2", cwd: f.repositoryPath }),
      );
      const blocked = yield* gate
        .reserve({
          ...worker,
          commandId: "execution-two",
          threadId: "foundry-launch:two",
          generation: 8,
        })
        .pipe(Effect.flip);
      assert.equal(blocked.code, "writer_busy");
      const binding = (yield* gate.bindings)[0]!;
      yield* gate.confirm(binding.requestId);
      assert.isFalse(
        yield* gate.starting({
          threadId: worker.threadId,
          runId: "late-run",
          cwd: f.repositoryPath,
        }),
      );
      assert.isTrue(
        yield* gate.starting({ threadId: "manual", runId: "manual-3", cwd: f.repositoryPath }),
      );
      assert.isFalse(
        yield* gate.starting({
          threadId: "another-manual",
          runId: "manual-4",
          cwd: f.repositoryPath,
        }),
      );
      assert.isTrue(yield* f.fs.exists(`${f.repositoryPath}/user.txt`));
    }).pipe(Effect.provide(gateLayer), Effect.scoped);
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live(
  "releases only the matching finished execution and retains reservations across lease loss",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const journal = ReservationStore.layer(`${f.temp}/reconcile.sqlite`);
      const gateLayer = Gate.layer([f.root]).pipe(
        Layer.provide(
          WorkspaceReservations.layer([f.root]).pipe(
            Layer.provide(WriterStopVerifier.layerBound.pipe(Layer.provide(journal))),
            Layer.provide(journal),
          ),
        ),
        Layer.provide(journal),
      );
      const runtime = Reconciler.layer.pipe(
        Layer.provideMerge(gateLayer),
        Layer.provideMerge(Executions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
        Layer.provide(Layer.mock(Threads.ThreadManagementService)({})),
        Layer.provide(Layer.mock(Sessions.ProviderSessionManagerV2)({})),
      );
      yield* Effect.gen(function* () {
        const gate = yield* WorkspaceGate;
        const executions = yield* Executions.ExecutionStore;
        const reconciler = yield* Reconciler.WorkspaceReconciler;
        const commandId = CommandId.make("bound-worker");
        const threadId = ThreadId.make("foundry-launch:bound-worker");
        const row = yield* executions.reserve(commandId, threadId);
        yield* gate.reserve({
          commandId,
          threadId,
          generation: row.generation,
          repositoryPath: f.repositoryPath,
          mode: "checkout",
        });
        yield* executions.uncertain(commandId);
        yield* reconciler.reconcile;
        assert.lengthOf(yield* gate.bindings, 1);
        assert.isFalse(
          yield* gate.starting({
            threadId: "manual",
            runId: "manual-conflict",
            cwd: f.repositoryPath,
          }),
        );
        yield* executions.stop(commandId);
        yield* reconciler.reconcile;
        assert.lengthOf(yield* gate.bindings, 1);
        yield* executions.finish(commandId, row.generation + 1, {
          generation: row.generation + 1,
          runId: RunId.make("bound-run"),
          outcome: "stopped",
          checkpointId: null,
          checkpointRef: null,
        });
        yield* reconciler.reconcile;
        assert.lengthOf(yield* gate.bindings, 1);
        yield* executions.finish(commandId, row.generation, {
          generation: row.generation,
          runId: RunId.make("bound-run"),
          outcome: "stopped",
          checkpointId: null,
          checkpointRef: null,
        });
        yield* reconciler.reconcile;
        assert.lengthOf(yield* gate.bindings, 0);
        assert.isFalse(yield* gate.starting({ threadId, runId: "late", cwd: f.repositoryPath }));
        assert.isTrue(
          yield* gate.starting({ threadId: "manual", runId: "manual-next", cwd: f.repositoryPath }),
        );
        yield* reconciler.reconcile;
        assert.lengthOf(yield* gate.bindings, 1);
      }).pipe(Effect.provide(runtime), Effect.scoped);
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("keeps manual writers reserved until their terminal run has positive native evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const journal = ReservationStore.layer(`${f.temp}/manual-proof.sqlite`);
    const gateLayer = Gate.layer([f.root]).pipe(
      Layer.provide(
        WorkspaceReservations.layer([f.root]).pipe(
          Layer.provide(WriterStopVerifier.layerBound.pipe(Layer.provide(journal))),
          Layer.provide(journal),
        ),
      ),
      Layer.provide(journal),
    );
    let nativeEnded = false;
    let runStatus = "running";
    let attemptStatus = "running";
    const records = () => ({
      attempts: [{ id: "attempt", status: attemptStatus, providerThreadId: "provider-thread" }],
      runs: [
        {
          id: "manual-run",
          status: runStatus,
          activeAttemptId: "attempt",
          providerThreadId: "provider-thread",
        },
      ],
      providerThreads: [{ id: "provider-thread", providerSessionId: "session" }],
      providerTurns: [{ runAttemptId: "attempt", nativeTurnRef: { nativeId: "native-turn" } }],
    });
    const threads = Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: (() =>
        Effect.succeed(
          records(),
        )) as Threads.ThreadManagementService["Service"]["getThreadRecords"],
    });
    const sessions = Layer.mock(Sessions.ProviderSessionManagerV2)({
      get: () =>
        Effect.succeedSome({
          confirmWriterEnded: () => Effect.succeed(nativeEnded),
        } as unknown as ProviderAdapterV2SessionRuntime),
    });
    const runtime = Reconciler.layer.pipe(
      Layer.provideMerge(gateLayer),
      Layer.provide(Executions.layer.pipe(Layer.provide(Sqlite.layerMemory))),
      Layer.provide(threads),
      Layer.provide(sessions),
    );
    yield* Effect.gen(function* () {
      const gate = yield* WorkspaceGate;
      const reconciler = yield* Reconciler.WorkspaceReconciler;
      yield* gate.installReconciler(reconciler.reconcile);
      assert.isTrue(
        yield* gate.prepare({
          threadId: "manual",
          runId: "manual-run",
          attemptId: "attempt",
          cwd: f.repositoryPath,
        }),
      );
      assert.isFalse(
        yield* gate.starting({ threadId: "other", runId: "other-run", cwd: f.repositoryPath }),
      );
      assert.isTrue(
        yield* gate.starting({
          threadId: "manual",
          runId: "manual-run",
          attemptId: "attempt",
          cwd: f.repositoryPath,
        }),
      );
      nativeEnded = true;
      yield* reconciler.reconcile;
      assert.lengthOf(yield* gate.bindings, 1);
      nativeEnded = false;
      runStatus = "completed";
      attemptStatus = "completed";
      assert.isFalse(
        yield* gate.starting({ threadId: "other", runId: "other-run", cwd: f.repositoryPath }),
      );
      nativeEnded = true;
      runStatus = "starting";
      attemptStatus = "superseded";
      assert.isTrue(
        yield* gate.starting({
          threadId: "manual",
          runId: "manual-run",
          attemptId: "retry-attempt",
          cwd: f.repositoryPath,
        }),
      );
      assert.isFalse(
        yield* gate.starting({ threadId: "other", runId: "other-run", cwd: f.repositoryPath }),
      );
      assert.isFalse(
        yield* gate.starting({
          threadId: "manual",
          runId: "manual-run",
          attemptId: "attempt",
          cwd: f.repositoryPath,
        }),
      );
      assert.isTrue(yield* f.fs.exists(`${f.repositoryPath}/user.txt`));
    }).pipe(Effect.provide(runtime), Effect.scoped);
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("keeps unbound development workers on the ordinary interactive path", () =>
  Effect.gen(function* () {
    const inactive = Gate.layerConfigured.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              FOUNDRY_WORKER_ENABLED: "true",
              FOUNDRY_WORKER_PROVIDER_INSTANCE_ID: "",
              FOUNDRY_WORKER_WORKSPACE_ROOTS: '["/nonexistent-unbound-worker-root"]',
            },
          }),
        ),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-unbound-worker-" })),
    );
    yield* Effect.gen(function* () {
      const gate = yield* WorkspaceGate;
      assert.isTrue(
        yield* gate.prepare({
          threadId: "replay",
          runId: "one",
          cwd: "/nonexistent-unbound-worker-root",
        }),
      );
      assert.isTrue(
        yield* gate.starting({
          threadId: "replay",
          runId: "one",
          cwd: "/nonexistent-unbound-worker-root",
        }),
      );
      assert.isTrue(
        yield* gate.starting({
          threadId: "replay",
          runId: "two",
          cwd: "/nonexistent-unbound-worker-root",
        }),
      );
      assert.lengthOf(yield* gate.bindings, 0);
    }).pipe(Effect.provide(inactive));
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live(
  "holds a handoff between turns and fences closing, stale starts and returned threads durably",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const journal = ReservationStore.layer(`${f.temp}/handoff.sqlite`);
      yield* Effect.gen(function* () {
        const store = yield* ReservationStore.ReservationStore;
        const service = yield* WorkspaceReservations.WorkspaceReservations;
        const hold = {
          id: "handoff",
          threadId: "interactive",
          workspacePath: f.repositoryPath,
          state: "opening" as const,
          payload: "request",
          receipt: null,
          result: null,
          closingCommand: null,
        };
        const reservation = {
          ...f.request("dispatch"),
          workspacePath: f.repositoryPath,
          baseCommit: "base",
          branch: null,
          state: "ready" as const,
        };
        const raced = yield* Effect.all(
          [store.hold(hold), store.claim(reservation, "automation")],
          { concurrency: "unbounded" },
        );
        assert.equal(raced.filter(Boolean).length, 1);
        if (raced[1]) {
          yield* store.setState("dispatch", "released");
          assert.isTrue(yield* store.hold(hold));
        }
        assert.isFalse(yield* store.handoffAllowed("interactive", f.repositoryPath));
        assert.isTrue(
          yield* store.transitionHandoff("handoff", "opening", "open", { receipt: "receipt" }),
        );
        assert.isTrue(yield* store.handoffAllowed("interactive", f.repositoryPath));
        assert.isFalse(yield* store.handoffAllowed("other", f.repositoryPath));
        assert.equal(
          (yield* service.reserve(f.request("other"), "other").pipe(Effect.flip)).code,
          "writer_busy",
        );
        const manual = yield* service.reserve(f.request("manual"), "interactive");
        yield* store.bind({
          requestId: manual.requestId,
          threadId: "interactive",
          commandId: null,
          generation: null,
        });
        assert.isTrue(
          yield* store.transitionHandoff("handoff", "open", "closing", {
            closingCommand: "finish",
          }),
        );
        assert.isFalse(yield* store.enter(manual.requestId, "interactive", "late-run"));
        yield* store.handoffCommand("reopen", "reopen-input");
        assert.isTrue(
          yield* store.transitionHandoff("handoff", "closing", "open", {
            command: { id: "reopen", payload: "reopen-input", result: "receipt" },
          }),
        );
        assert.equal(yield* store.handoffCommand("reopen", "reopen-input"), "receipt");
        assert.isTrue(yield* store.enter(manual.requestId, "interactive", "run"));
        assert.isFalse(yield* store.enter(manual.requestId, "interactive", "second-run"));
        yield* store.confirm(manual.requestId);
        yield* service.release(manual.requestId);
        assert.isFalse(
          yield* store.claim({ ...reservation, requestId: "between-turns" }, "automation"),
        );
        yield* store.transitionHandoff("handoff", "open", "closing", {
          closingCommand: "finish-new",
        });
        yield* store.handoffCommand("finish-new", "finish-input");
        assert.isTrue(
          yield* store.transitionHandoff("handoff", "closing", "returned", {
            result: "result",
            command: { id: "finish-new", payload: "finish-input", result: "result" },
          }),
        );
        assert.isFalse(yield* store.handoffAllowed("interactive", f.repositoryPath));
        assert.isFalse(
          yield* store.claim({ ...reservation, requestId: "late-interactive" }, "interactive"),
        );
        assert.isTrue(
          yield* store.claim({ ...reservation, requestId: "next-automation" }, "automation"),
        );
      }).pipe(
        Effect.provide(
          WorkspaceReservations.layer([f.root]).pipe(
            Layer.provideMerge(journal),
            Layer.provide(WriterStopVerifier.layerBound.pipe(Layer.provide(journal))),
          ),
        ),
        Effect.scoped,
      );
      yield* Effect.gen(function* () {
        const store = yield* ReservationStore.ReservationStore;
        assert.equal((yield* store.handoff("handoff"))?.state, "returned");
        assert.equal(yield* store.handoffCommand("finish-new", "finish-input"), "result");
        assert.isFalse(yield* store.handoffAllowed("interactive", f.repositoryPath));
      }).pipe(Effect.provide(journal), Effect.scoped);
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);
