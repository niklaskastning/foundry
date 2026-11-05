// @effect-diagnostics nodeBuiltinImport:off -- Assertions run against the isolated PostgreSQL fixture.
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as DispatchStore from "../src/automation/DispatchStore.ts";

const isDispatchError = Schema.is(DispatchStore.DispatchError);

export const parallelGates = Effect.fn("AutomationParallel.postgresGates")(function* <E, E2>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
  restart: Effect.Effect<void, E2>,
) {
  const services = DispatchStore.layer.pipe(
    Layer.provideMerge(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
    Layer.provideMerge(database),
  );
  const call = <A, E3>(
    operation: (store: DispatchStore.DispatchStore["Service"]) => Effect.Effect<A, E3>,
  ) => DispatchStore.DispatchStore.pipe(Effect.flatMap(operation), Effect.provide(services));
  yield* Effect.gen(function* () {
    const factory = yield* Factories.Factories;
    const workflows = yield* Workflows.Workflows;
    yield* factory.createFactory({
      commandId: "parallel-factory",
      id: "parallel",
      name: "Parallel",
    });
    yield* factory.createVersion({
      commandId: "parallel-version",
      id: "parallel-version",
      factoryId: "parallel",
      repositories: ["fixture"],
    });
    yield* factory.createWorkItem({
      commandId: "parallel-work",
      id: "parallel-work",
      factoryId: "parallel",
      versionId: "parallel-version",
      repository: "fixture",
      title: "Parallel",
      source: { kind: "manual", reference: "fixture" },
    });
    yield* workflows.createVersion({
      commandId: "parallel-flow",
      id: "parallel-flow",
      factoryId: "parallel",
      factoryVersionId: "parallel-version",
      execution: {
        mode: "parallel",
        maxParallelism: 2,
        maxRepairRounds: 1,
        join: "all_succeeded",
        failurePolicy: "repair_failed",
        joinStepId: "join",
      },
      steps: [
        { id: "left", kind: "agent", prompt: "Left", dependsOn: [] },
        { id: "right", kind: "agent", prompt: "Right", dependsOn: [] },
        { id: "join", kind: "agent", prompt: "Join", dependsOn: ["left", "right"] },
      ],
    });
  }).pipe(Effect.provide(services));
  const start = Effect.fn("ParallelGate.start")(function* (
    id: string,
    workflowVersionId = "parallel-flow",
  ) {
    yield* Workflows.Workflows.pipe(
      Effect.flatMap((workflows) =>
        workflows.start({
          commandId: id,
          id,
          factoryId: "parallel",
          workItemId: "parallel-work",
          workflowVersionId,
          revision: "pinned",
        }),
      ),
      Effect.provide(services),
    );
    yield* call((store) =>
      store.enroll({ factoryId: "parallel", runId: id, workerId: id, binding: {} }),
    );
    const claim = yield* call((store) =>
      store.claimNext({ workerId: id, owner: "parallel-owner", leaseMillis: 60000 }),
    );
    NodeAssert.ok(claim);
    return claim;
  });
  const target = (workerId: string) => ({
    workerId,
    binding: { projectId: workerId },
    capacity: 1,
  });
  const prepare = (
    claim: DispatchStore.DispatchClaim,
    ordinal: number,
    workerId: string,
    capacity = 1,
  ) =>
    call((store) =>
      store.prepare(claim, {
        ordinal,
        commandId: `${claim.run.id}-${ordinal}`,
        request: {
          commandId: `${claim.run.id}-${ordinal}`,
          projectId: workerId,
          title: "Parallel fixture",
          model: "fixture",
          prompt: "fixture",
        },
        target: { ...target(workerId), capacity },
      }),
    );
  const refresh = (claim: DispatchStore.DispatchClaim) =>
    call((store) => store.read("parallel", claim.run.id)).pipe(
      Effect.map((current) => ({ ...claim, ...current })),
    );
  const result = (commandId: string) => ({
    execution: {
      receipt: {
        commandId,
        threadId: `thread-${commandId}`,
        acceptedAt: "2026-11-05T00:00:00Z",
        sequence: 1,
      },
      run: { id: `native-${commandId}`, status: "completed", checkpointId: null },
      lifecycle: {
        generation: 1,
        expiresAt: 0,
        state: "stopped",
        writerEnded: true,
        manifest: null,
      },
    },
    artifacts: [],
    summary: `Attempt output ${commandId}`,
  });
  const finish = (
    claim: DispatchStore.DispatchClaim,
    commandId: string,
    state: "succeeded" | "failed",
  ) =>
    call((store) =>
      store.record(claim, {
        commandId,
        state,
        reason: state === "failed" ? "worker_failed" : null,
        receipt: null,
        result: result(commandId),
      }),
    );

  const first = yield* start("parallel-first");
  const other = yield* start("parallel-other");
  const races = yield* Effect.all(
    [
      prepare(first, 0, "parallel-shared").pipe(Effect.result),
      prepare(other, 0, "parallel-shared").pipe(Effect.result),
    ],
    { concurrency: "unbounded" },
  );
  NodeAssert.equal(races.filter((entry) => entry._tag === "Success").length, 1);
  NodeAssert.equal((yield* call((store) => store.workerCapacity("parallel-shared")))?.occupied, 1);
  const winner = races[0]!._tag === "Success" ? first : other;
  const loser = winner === first ? other : first;
  const left = (yield* refresh(winner)).attempts[0]!;
  const right = yield* prepare(winner, 1, "parallel-right");
  NodeAssert.equal((yield* refresh(winner)).attempts.length, 2);
  const earlyJoin = yield* prepare(winner, 2, "parallel-join").pipe(Effect.flip);
  NodeAssert.ok(isDispatchError(earlyJoin));
  NodeAssert.equal(earlyJoin.reason, "invalid_step");

  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-paused", capacity: 1, paused: true }),
  );
  const pausedError = yield* prepare(loser, 0, "parallel-paused").pipe(Effect.flip);
  NodeAssert.ok(isDispatchError(pausedError));
  NodeAssert.equal(pausedError.reason, "capacity_unavailable");
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-paused", capacity: 1, paused: false }),
  );
  const resumed = yield* prepare(loser, 0, "parallel-paused");
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-paused", capacity: 1, paused: true }),
  );
  NodeAssert.equal(yield* call((store) => store.beginDelivery(loser, resumed.commandId)), false);
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-paused", capacity: 1, paused: false }),
  );
  NodeAssert.equal(yield* call((store) => store.beginDelivery(loser, resumed.commandId)), true);
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-paused", capacity: 1, paused: true }),
  );
  NodeAssert.equal(yield* call((store) => store.beginDelivery(loser, resumed.commandId)), true);

  NodeAssert.equal(yield* finish(winner, left.commandId, "failed"), true);
  NodeAssert.equal((yield* refresh(winner)).state, "running");
  NodeAssert.equal((yield* call((store) => store.workerCapacity("parallel-shared")))?.occupied, 0);
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-shared", capacity: 1, paused: true }),
  );
  const repairPaused = yield* call((store) => store.repair(winner, left.commandId)).pipe(
    Effect.flip,
  );
  NodeAssert.ok(isDispatchError(repairPaused));
  NodeAssert.equal(repairPaused.reason, "capacity_unavailable");
  NodeAssert.equal((yield* refresh(winner)).attempts.length, 2);
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-shared", capacity: 1, paused: false }),
  );
  const repairs = yield* Effect.all(
    [
      call((store) => store.repair(winner, left.commandId)),
      call((store) => store.repair(winner, left.commandId)),
    ],
    { concurrency: "unbounded" },
  );
  NodeAssert.ok(repairs[0]);
  NodeAssert.equal(repairs[0].commandId, repairs[1]?.commandId);
  NodeAssert.equal(repairs[0].attemptNumber, 1);
  NodeAssert.equal((yield* refresh(winner)).attempts.length, 3);
  yield* finish(winner, right.commandId, "succeeded");
  const repairingJoin = yield* prepare(yield* refresh(winner), 2, "parallel-join").pipe(
    Effect.flip,
  );
  NodeAssert.ok(isDispatchError(repairingJoin));
  NodeAssert.equal(repairingJoin.reason, "invalid_step");
  yield* call((store) => store.release(winner));
  NodeAssert.equal(yield* call((store) => store.renewClaim(winner, 60000)), false);
  yield* restart;
  const recovered = yield* call((store) =>
    store.claimNext({ workerId: winner.workerId, owner: "recovered-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(recovered);
  NodeAssert.equal(yield* call((store) => store.renewClaim(winner, 60000)), false);
  NodeAssert.equal(yield* call((store) => store.renewClaim(recovered, 60000)), true);
  NodeAssert.equal(
    (yield* call((store) => store.repair(recovered, left.commandId)))?.commandId,
    repairs[0].commandId,
  );
  NodeAssert.equal((yield* call((store) => store.workerCapacity("parallel-shared")))?.occupied, 1);
  NodeAssert.equal(yield* finish(winner, repairs[0].commandId, "succeeded"), false);
  yield* finish(recovered, repairs[0].commandId, "succeeded");
  NodeAssert.equal(yield* finish(recovered, left.commandId, "failed"), true);
  NodeAssert.equal((yield* refresh(recovered)).attempts.length, 3);
  const joinClaim = yield* refresh(recovered);
  const join = yield* prepare(joinClaim, 2, "parallel-join");
  NodeAssert.deepEqual(yield* prepare(joinClaim, 2, "parallel-join"), join);
  yield* finish(recovered, join.commandId, "succeeded");
  NodeAssert.equal((yield* refresh(recovered)).state, "succeeded");
  NodeAssert.equal((yield* call((store) => store.workerCapacity("parallel-join")))?.occupied, 0);

  const exhausted = yield* start("parallel-exhausted");
  const failed = yield* prepare(exhausted, 0, "parallel-budget");
  const sibling = yield* prepare(exhausted, 1, "parallel-budget-sibling");
  yield* finish(exhausted, failed.commandId, "failed");
  const retry = yield* call((store) => store.repair(exhausted, failed.commandId));
  NodeAssert.ok(retry);
  yield* finish(exhausted, retry.commandId, "failed");
  NodeAssert.equal(yield* call((store) => store.repair(exhausted, retry.commandId)), null);
  NodeAssert.equal((yield* refresh(exhausted)).state, "running");
  yield* finish(exhausted, sibling.commandId, "succeeded");
  NodeAssert.equal((yield* refresh(exhausted)).state, "failed");
  NodeAssert.equal((yield* refresh(exhausted)).reason, "repair_exhausted");
  NodeAssert.equal((yield* call((store) => store.workerCapacity("parallel-budget")))?.occupied, 0);

  const cancelled = yield* start("parallel-cancel");
  const sent = yield* prepare(cancelled, 0, "parallel-cancel-left");
  const unsent = yield* prepare(cancelled, 1, "parallel-cancel-right");
  NodeAssert.equal(
    yield* call((store) => store.confirmUndelivered(cancelled, unsent.commandId)),
    false,
  );
  yield* call((store) => store.beginDelivery(cancelled, unsent.commandId));
  NodeAssert.equal(yield* call((store) => store.deliveryState(sent.commandId)), "pending");
  yield* call((store) => store.beginDelivery(cancelled, sent.commandId));
  NodeAssert.equal(yield* call((store) => store.deliveryState(sent.commandId)), "sending");
  yield* Database.AutomationDatabase.pipe(
    Effect.flatMap(
      (sql) =>
        sql`UPDATE foundry_automation.run_controls SET mode='cancel_requested' WHERE run_id=${cancelled.run.id}`,
    ),
    Effect.provide(database),
  );
  NodeAssert.equal(yield* call((store) => store.confirmCancel(cancelled)), false);
  NodeAssert.equal(
    (yield* call((store) => store.workerCapacity("parallel-cancel-left")))?.occupied,
    1,
  );
  yield* finish(cancelled, sent.commandId, "failed");
  NodeAssert.equal(yield* call((store) => store.confirmCancel(cancelled)), false);
  NodeAssert.equal(
    (yield* call((store) => store.workerCapacity("parallel-cancel-right")))?.occupied,
    1,
  );
  NodeAssert.equal(
    yield* call((store) => store.confirmUndelivered(cancelled, unsent.commandId)),
    true,
  );
  NodeAssert.equal(
    yield* call((store) => store.confirmUndelivered(cancelled, unsent.commandId)),
    true,
  );
  NodeAssert.equal(yield* call((store) => store.confirmCancel(cancelled)), true);
  NodeAssert.equal(
    (yield* call((store) => store.workerCapacity("parallel-cancel-right")))?.occupied,
    0,
  );
  NodeAssert.equal((yield* refresh(cancelled)).mode, "cancelled");
  yield* Workflows.Workflows.pipe(
    Effect.flatMap((workflows) =>
      Effect.gen(function* () {
        const workflow = yield* workflows.readVersion("parallel", "parallel-flow");
        yield* workflows.createVersion({
          ...workflow,
          commandId: "parallel-budget-flow",
          id: "parallel-budget-flow",
          execution: { ...workflow.execution!, maxParallelism: 1 },
        });
      }),
    ),
    Effect.provide(services),
  );
  const budget = yield* start("parallel-single-slot", "parallel-budget-flow");
  const budgetLeft = yield* prepare(budget, 0, "parallel-budget-left");
  const budgetError = yield* prepare(budget, 1, "parallel-budget-right").pipe(Effect.flip);
  NodeAssert.ok(isDispatchError(budgetError));
  NodeAssert.equal(budgetError.reason, "invalid_step");
  const upgraded = yield* start("parallel-capacity-upgrade");
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-budget-left", capacity: 1, paused: true }),
  );
  const upgradePaused = yield* prepare(upgraded, 0, "parallel-budget-left", 2).pipe(Effect.flip);
  NodeAssert.ok(isDispatchError(upgradePaused));
  NodeAssert.equal(upgradePaused.reason, "capacity_unavailable");
  NodeAssert.equal(
    (yield* call((store) => store.workerCapacity("parallel-budget-left")))?.paused,
    true,
  );
  yield* call((store) =>
    store.configureWorker({ workerId: "parallel-budget-left", capacity: 1, paused: false }),
  );
  yield* prepare(upgraded, 0, "parallel-budget-left", 2);
  const expanded = yield* call((store) => store.workerCapacity("parallel-budget-left"));
  NodeAssert.equal(expanded?.capacity, 2);
  NodeAssert.equal(expanded?.occupied, 2);
  yield* finish(budget, budgetLeft.commandId, "succeeded");
  NodeAssert.equal(
    (yield* prepare(yield* refresh(budget), 1, "parallel-budget-right")).state,
    "pending",
  );
});
