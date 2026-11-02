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
