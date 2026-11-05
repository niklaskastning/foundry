import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  ProviderThreadId,
  RunId,
  CheckpointId,
  FoundryArchiveError,
  FoundryArtifactId,
  FoundryInstanceId,
  FoundryDeviceId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ExecutionStore from "./ExecutionStore.ts";
import * as ArchivePublication from "./ArchivePublication.ts";

const commandId = CommandId.make("lease-test");
const threadId = ThreadId.make("foundry-launch:lease-test");
const start = { threadId, providerThreadId: ProviderThreadId.make("native-thread"), runOrdinal: 1 };
const testLayer = ExecutionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("reserves bounded capacity atomically and retains uncertain writers across restart", () =>
  Effect.gen(function* () {
    const store = yield* ExecutionStore.ExecutionStore;
    const attempts = yield* Effect.forEach(
      [0, 1, 2],
      (index) =>
        store
          .reserve(
            CommandId.make(`capacity-${index}`),
            ThreadId.make(`foundry-launch:capacity-${index}`),
            2,
          )
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.equal(attempts.filter((result) => result._tag === "Success").length, 2);
    assert.equal(yield* store.occupied, 2);
    const first = attempts.find((result) => result._tag === "Success")!;
    assert.equal(first._tag, "Success");
    if (first._tag !== "Success") return;
    const row = first.success;
    assert.deepEqual(yield* store.reserve(row.commandId, row.threadId, 2), row);
    assert.isTrue(yield* store.starting({ ...start, threadId: row.threadId }));
    yield* store.stop(row.commandId);
    assert.equal(yield* store.occupied, 2);
    yield* Effect.gen(function* () {
      const recovered = yield* ExecutionStore.ExecutionStore;
      assert.equal(yield* recovered.occupied, 2);
      yield* recovered.confirm(row.commandId, row.generation + 1);
      assert.equal(yield* recovered.occupied, 2);
      yield* recovered.confirm(row.commandId, row.generation);
      assert.equal(yield* recovered.occupied, 1);
      yield* recovered.reserve(
        CommandId.make("replacement"),
        ThreadId.make("foundry-launch:replacement"),
        2,
      );
      assert.equal(yield* recovered.occupied, 2);
    }).pipe(Effect.provide(Layer.fresh(ExecutionStore.layer)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "persists admission, renewal and monotone generations without reviving expired writers",
  () =>
    Effect.gen(function* () {
      const store = yield* ExecutionStore.ExecutionStore;
      const first = yield* store.reserve(commandId, threadId);
      assert.deepEqual(yield* store.reserve(commandId, threadId), first);
      assert.isTrue(yield* store.starting(start));
      assert.isFalse(yield* store.starting(start));
      assert.isTrue(yield* store.renew(commandId, first.generation));
      assert.isFalse(yield* store.renew(commandId, first.generation + 1));
      yield* TestClock.adjust("60 seconds");
      const expired = yield* store.sweep;
      assert.deepInclude(expired[0], { state: "stopping", writerEnded: 0 });
      assert.isFalse(yield* store.renew(commandId, first.generation));
      assert.isFalse(yield* store.starting(start));
      const second = yield* store.reserve(
        CommandId.make("another"),
        ThreadId.make("foundry-launch:another"),
        2,
      );
      assert.isAbove(second.generation, first.generation);
      assert.isTrue(
        yield* store.starting({ ...start, threadId: ThreadId.make("ordinary-interactive") }),
      );
      assert.isFalse(
        yield* store.starting({ ...start, threadId: ThreadId.make("foundry-launch:missing") }),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("cancel before start fences future invocation and proves the writer never entered", () =>
  Effect.gen(function* () {
    const store = yield* ExecutionStore.ExecutionStore;
    yield* store.reserve(commandId, threadId);
    yield* store.stop(commandId);
    assert.deepInclude(yield* store.read(commandId), { state: "finalizing", writerEnded: 1 });
    assert.isFalse(yield* store.starting(start));
    assert.deepInclude(yield* store.read(commandId), { state: "finalizing", writerEnded: 1 });
    const abandoned = CommandId.make("never-delivered");
    const cancellation = CommandId.make("cancel-never-delivered");
    assert.isTrue(yield* store.cancelUnstarted(cancellation, abandoned));
    yield* Effect.gen(function* () {
      const recovered = yield* ExecutionStore.ExecutionStore;
      assert.equal(yield* recovered.cancellation(cancellation), abandoned);
      assert.isTrue(yield* recovered.cancelUnstarted(cancellation, abandoned));
      assert.equal(
        (yield* recovered
          .reserve(abandoned, ThreadId.make("foundry-launch:never-delivered"))
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(yield* recovered.occupied, 0);
      assert.equal(
        (yield* recovered.cancelUnstarted(cancellation, commandId).pipe(Effect.result))._tag,
        "Failure",
      );
      const reserved = yield* recovered.reserve(
        CommandId.make("reserved-cancel"),
        ThreadId.make("foundry-launch:reserved-cancel"),
      );
      assert.isTrue(
        yield* recovered.cancelUnstarted(CommandId.make("cancel-reserved"), reserved.commandId),
      );
      assert.isFalse(yield* recovered.starting({ ...start, threadId: reserved.threadId }));
      assert.equal(yield* recovered.occupied, 0);
      const active = yield* recovered.reserve(
        CommandId.make("active-cancel"),
        ThreadId.make("foundry-launch:active-cancel"),
      );
      assert.isTrue(yield* recovered.starting({ ...start, threadId: active.threadId }));
      assert.isFalse(
        yield* recovered.cancelUnstarted(CommandId.make("cancel-active"), active.commandId),
      );
      assert.equal(yield* recovered.occupied, 1);
    }).pipe(Effect.provide(Layer.fresh(ExecutionStore.layer)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "restart keeps the original generation uncertain and rejects late proofs and manifests",
  () =>
    Effect.gen(function* () {
      const store = yield* ExecutionStore.ExecutionStore;
      const first = yield* store.reserve(commandId, threadId);
      assert.isTrue(yield* store.starting(start));
      yield* Effect.gen(function* () {
        const recovered = yield* ExecutionStore.ExecutionStore;
        const row = yield* recovered.reserve(commandId, threadId);
        assert.deepInclude(row, {
          generation: first.generation,
          state: "uncertain",
          writerEnded: 0,
        });
        assert.isFalse(yield* recovered.renew(commandId, first.generation));
        assert.isFalse(yield* recovered.starting(start));
        yield* recovered.confirm(commandId, first.generation + 1);
        assert.equal((yield* recovered.read(commandId))?.writerEnded, 0);
        const manifest = {
          generation: first.generation,
          runId: RunId.make("run"),
          checkpointId: CheckpointId.make("checkpoint"),
          checkpointRef: "refs/checkpoints/result",
          outcome: "completed" as const,
        };
        yield* recovered.finish(commandId, first.generation, manifest);
        assert.isNull((yield* recovered.read(commandId))?.manifest);
        yield* recovered.confirm(commandId, first.generation);
        yield* recovered.finish(commandId, first.generation, manifest);
        assert.isNull((yield* recovered.read(commandId))?.manifest);
        yield* recovered.finish(commandId, first.generation, { ...manifest, outcome: "stopped" });
        const finished = yield* recovered.read(commandId);
        assert.equal(finished?.state, "stopped");
        yield* recovered.finish(commandId, first.generation + 1, {
          ...manifest,
          generation: first.generation + 1,
        });
        assert.deepEqual(yield* recovered.read(commandId), finished);
      }).pipe(Effect.provide(Layer.fresh(ExecutionStore.layer)));
    }).pipe(Effect.provide(testLayer)),
);

it.effect("requires a complete central archive before recording a successful result", () => {
  let mode = "unavailable";
  const confirmation = {
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
    deviceGeneration: 3,
    owner: { environmentId: EnvironmentId.make("worker"), threadId },
    confirmedCursor: 7,
    confirmedSourceSequence: 19,
    sourceHead: 7,
    sourceComplete: true,
    missingArtifacts: [],
    missingAttachmentCount: 0,
  };
  const archive = {
    reconcile: () =>
      mode === "unavailable"
        ? Effect.fail(new FoundryArchiveError({ code: "unavailable" }))
        : Effect.succeed({
            ...confirmation,
            complete: mode !== "incomplete",
            sourceComplete: mode !== "source_incomplete",
            confirmedCursor: mode === "cursor_gap" ? 6 : confirmation.confirmedCursor,
            confirmedSourceSequence:
              mode === "missing_sequence" ? 0 : confirmation.confirmedSourceSequence,
            missingAttachmentCount: mode === "missing_attachment" ? 1 : 0,
            missingArtifacts:
              mode === "missing_blob"
                ? [
                    {
                      instanceId: confirmation.instanceId,
                      artifactId: FoundryArtifactId.make("33333333-3333-4333-8333-333333333333"),
                      owner: confirmation.owner,
                    },
                  ]
                : [],
            owner:
              mode === "wrong_thread"
                ? { ...confirmation.owner, threadId: ThreadId.make("another-thread") }
                : confirmation.owner,
          }),
  };
  return Effect.gen(function* () {
    const store = yield* ExecutionStore.ExecutionStore;
    const row = yield* store.reserve(commandId, threadId);
    const manifest = {
      generation: row.generation,
      runId: RunId.make("run"),
      checkpointId: CheckpointId.make("checkpoint"),
      checkpointRef: "refs/checkpoints/result",
      outcome: "completed" as const,
    };
    mode = "complete";
    yield* store.finish(commandId, row.generation, manifest);
    assert.isNull((yield* store.read(commandId))?.manifest);
    yield* store.confirm(commandId, row.generation);
    yield* store.finish(commandId, row.generation, { ...manifest, checkpointId: null });
    assert.isNull((yield* store.read(commandId))?.manifest);
    yield* store.finish(commandId, row.generation, { ...manifest, checkpointRef: null });
    assert.isNull((yield* store.read(commandId))?.manifest);
    for (const next of [
      "unavailable",
      "incomplete",
      "source_incomplete",
      "cursor_gap",
      "missing_sequence",
      "missing_attachment",
      "missing_blob",
      "wrong_thread",
      "complete",
    ]) {
      mode = next;
      yield* store.finish(commandId, row.generation, manifest);
      assert.equal(
        (yield* store.read(commandId))?.state,
        mode === "complete" ? "completed" : "finalizing",
      );
    }
    const finished = yield* store.read(commandId);
    assert.deepEqual(JSON.parse(finished!.manifest!).archive, {
      instanceId: confirmation.instanceId,
      deviceId: confirmation.deviceId,
      deviceGeneration: confirmation.deviceGeneration,
      owner: confirmation.owner,
      cursor: confirmation.confirmedCursor,
      sourceSequence: confirmation.confirmedSourceSequence,
    });
    mode = "unavailable";
    yield* store.finish(commandId, row.generation, manifest);
    assert.deepEqual(yield* store.read(commandId), finished);
  }).pipe(
    Effect.provide(
      testLayer.pipe(Layer.provide(Layer.succeed(ArchivePublication.ArchivePublication, archive))),
    ),
  );
});
