import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  FoundryArtifactId,
  FoundryArtifactError,
  type FoundryArtifactManifest,
  FoundryDeviceId,
  FoundryInstanceId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type FoundryArchiveEvent,
  type FoundryArchiveStatus,
  type FoundryWorkerExecution,
  type FoundryWorkerLaunchInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Artifacts from "../foundry/Artifacts.ts";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as Scheduler from "./Scheduler.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import { decideStep } from "./stepDecision.ts";

const fixture = () => {
  const now = DateTime.makeUnsafe("2026-11-03T20:00:00Z");
  const threadId = ThreadId.make("p19-fixture-thread");
  const runId = RunId.make("p19-fixture-run");
  const checkpointId = CheckpointId.make("p19-fixture-checkpoint");
  const checkpointRef = CheckpointRef.make("refs/checkpoints/p19-fixture");
  const providerInstanceId = ProviderInstanceId.make("fixture");
  const providerThreadId = ProviderThreadId.make("p19-native-thread");
  const providerTurnId = ProviderTurnId.make("p19-native-turn");
  const runAttemptId = RunAttemptId.make("p19-native-attempt");
  const nodeId = NodeId.make("p19-node");
  const identity = {
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("p19-isolated-worker"),
    operatorId: "fixture-operator",
    deviceGeneration: 1,
    accessGeneration: 1,
    automationGeneration: 1,
    clientSessionId: AuthSessionId.make("fixture-session"),
    foundrySessionHash: "a".repeat(43),
  };
  const owner = { environmentId: identity.environmentId, threadId };
  const events: FoundryArchiveEvent[] = [
    {
      sequence: 1,
      sourceSequence: 11,
      event: {
        id: EventId.make("run-completed"),
        threadId,
        occurredAt: now,
        type: "run.updated",
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "fixture" },
          providerThreadId,
          userMessageId: MessageId.make("fixture-message"),
          rootNodeId: nodeId,
          activeAttemptId: runAttemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId,
          contextHandoffId: null,
        },
      },
    },
    {
      sequence: 2,
      sourceSequence: 14,
      event: {
        id: EventId.make("checkpoint-ready"),
        threadId,
        occurredAt: now,
        type: "checkpoint.captured",
        payload: {
          id: checkpointId,
          threadId,
          scopeId: CheckpointScopeId.make("fixture-scope"),
          runId,
          nodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: checkpointRef,
          status: "ready",
          files: [],
          capturedAt: now,
        },
      },
    },
    {
      sequence: 3,
      sourceSequence: 17,
      event: {
        id: EventId.make("provider-turn-completed"),
        threadId,
        occurredAt: now,
        type: "provider-turn.updated",
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      },
    },
    {
      sequence: 4,
      sourceSequence: 18,
      event: {
        id: EventId.make("test-completed"),
        threadId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make("fixture-test"),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "fixture-test-command",
          cwd: "/isolated/p19-fixture",
          exitCode: 0,
        },
      },
    },
  ];
  const archive: FoundryArchiveStatus = {
    owner,
    confirmedCursor: 4,
    confirmedSourceSequence: 18,
    sourceHead: 18,
    sourceComplete: true,
    complete: true,
    missingArtifacts: [],
    missingAttachmentCount: 0,
  };
  const execution: FoundryWorkerExecution = {
    receipt: {
      commandId: CommandId.make("fixture-command"),
      threadId,
      acceptedAt: "2026-11-03T20:00:00Z",
      sequence: 1,
    },
    run: { id: runId, status: "completed", checkpointId },
    lifecycle: {
      generation: 1,
      expiresAt: 60000,
      state: "completed",
      writerEnded: true,
      manifest: {
        generation: 1,
        runId,
        checkpointId,
        checkpointRef,
        outcome: "completed",
        archive: {
          instanceId: identity.instanceId,
          deviceId: identity.deviceId,
          deviceGeneration: 1,
          owner,
          cursor: 4,
          sourceSequence: 18,
        },
      },
    },
  };
  return {
    identity,
    execution,
    archive,
    events,
    command: "fixture-test-command",
    cwd: "/isolated/p19-fixture",
    artifactsReady: true,
  };
};

it("requires matching final worker, checkpoint, archive and test evidence", () => {
  const good = fixture();
  assert.deepEqual(decideStep(good), { state: "succeeded", reason: null });
  const lifecycle = good.execution.lifecycle!;
  const manifest = lifecycle.manifest!;
  const withLifecycle = (change: Partial<typeof lifecycle>) => ({
    ...good,
    execution: { ...good.execution, lifecycle: { ...lifecycle, ...change } },
  });
  const cases: ReadonlyArray<readonly [Parameters<typeof decideStep>[0], string]> = [
    [withLifecycle({ writerEnded: false }), "writer_end_pending"],
    [withLifecycle({ manifest: null }), "worker_result_pending"],
    [withLifecycle({ manifest: { ...manifest, generation: 2 } }), "worker_result_mismatch"],
    [withLifecycle({ manifest: { ...manifest, checkpointRef: null } }), "checkpoint_pending"],
    [withLifecycle({ manifest: { ...manifest, archive: undefined } }), "archive_pending"],
    [{ ...good, archive: { ...good.archive, complete: false } }, "archive_pending"],
    [{ ...good, archive: { ...good.archive, sourceComplete: false } }, "archive_pending"],
    [{ ...good, archive: { ...good.archive, missingAttachmentCount: 1 } }, "archive_pending"],
    [{ ...good, archive: { ...good.archive, confirmedSourceSequence: 17 } }, "archive_pending"],
    [
      {
        ...good,
        archive: {
          ...good.archive,
          owner: { ...good.archive.owner, threadId: ThreadId.make("foreign") },
        },
      },
      "archive_mismatch",
    ],
    [{ ...good, events: good.events.slice(1) }, "archive_gap"],
    [{ ...good, events: good.events.slice(0, 3) }, "required_events_pending"],
    [{ ...good, artifactsReady: false }, "artifacts_pending"],
    [{ ...good, command: "different-command" }, "test_result_pending"],
    [{ ...good, cwd: "/different-project" }, "test_result_pending"],
  ];
  for (const [input, reason] of cases) {
    const result = decideStep(input);
    assert.notEqual(result.state, "succeeded");
    assert.equal(result.reason, reason);
  }
  const testEvent = good.events[3]!;
  assert.equal(testEvent.event.type, "turn-item.updated");
  if (
    testEvent.event.type !== "turn-item.updated" ||
    testEvent.event.payload.type !== "command_execution"
  )
    throw new Error("fixture");
  for (const exitCode of [1, 2]) {
    const events = [
      ...good.events.slice(0, 3),
      {
        ...testEvent,
        event: { ...testEvent.event, payload: { ...testEvent.event.payload, exitCode } },
      },
    ];
    assert.deepEqual(decideStep({ ...good, events }), { state: "failed", reason: "test_failed" });
  }
  const missingExit = {
    ...testEvent,
    event: { ...testEvent.event, payload: { ...testEvent.event.payload, exitCode: undefined } },
  };
  assert.equal(
    decideStep({ ...good, events: [...good.events.slice(0, 3), missingExit] }).reason,
    "test_result_pending",
  );
  const turnEvent = good.events[2]!;
  if (turnEvent.event.type !== "provider-turn.updated") throw new Error("fixture");
  const oldAttempt = {
    ...turnEvent,
    event: {
      ...turnEvent.event,
      payload: { ...turnEvent.event.payload, runAttemptId: RunAttemptId.make("old-attempt") },
    },
  };
  assert.equal(
    decideStep({ ...good, events: [...good.events.slice(0, 2), oldAttempt, testEvent] }).reason,
    "test_attempt_pending",
  );
});

it.effect(
  "reconciles a lost launch reply and advances only after confirmed writer and results",
  () =>
    Effect.gen(function* () {
      const base = fixture();
      const artifact: FoundryArtifactManifest = {
        reference: {
          instanceId: base.identity.instanceId,
          artifactId: FoundryArtifactId.make("33333333-3333-4333-8333-333333333333"),
          owner: base.archive.owner,
        },
        name: "handoff.txt",
        mimeType: "text/plain",
        sizeBytes: 22,
        sha256: "ae7123bdcbc22cba23fb3940243fc190b1261beb3367c12a7ef61a00ea751cc9",
      };
      const message: FoundryArchiveEvent = {
        sequence: 5,
        sourceSequence: 19,
        event: {
          id: EventId.make("artifact-message"),
          threadId: base.execution.receipt.threadId,
          occurredAt: base.events[0]!.event.occurredAt,
          type: "message.updated",
          payload: {
            id: MessageId.make("artifact-message"),
            threadId: base.execution.receipt.threadId,
            runId: base.execution.run.id,
            nodeId: null,
            createdBy: "agent",
            creationSource: "provider",
            role: "assistant",
            text: "Required result",
            streaming: false,
            createdAt: base.events[0]!.event.occurredAt,
            updatedAt: base.events[0]!.event.occurredAt,
            attachments: [
              {
                type: "file",
                id: "handoff",
                name: artifact.name,
                mimeType: artifact.mimeType,
                sizeBytes: artifact.sizeBytes,
                foundryArtifact: artifact,
              },
            ],
          },
        },
      };
      const proof = {
        ...base,
        events: [...base.events, message],
        archive: {
          ...base.archive,
          confirmedCursor: 5,
          confirmedSourceSequence: 19,
          sourceHead: 19,
        },
        execution: {
          ...base.execution,
          lifecycle: {
            ...base.execution.lifecycle!,
            manifest: {
              ...base.execution.lifecycle!.manifest!,
              archive: {
                ...base.execution.lifecycle!.manifest!.archive!,
                cursor: 5,
                sourceSequence: 19,
              },
            },
          },
        },
      };
      let artifactMode: "missing" | "changed" | "ready" = "missing";
      const attempts: DispatchStore.DispatchAttempt[] = [];
      const launches: FoundryWorkerLaunchInput[] = [];
      const executions = new Map<string, FoundryWorkerExecution>();
      let generation = 0;
      let mode: NonNullable<DispatchStore.DispatchRun["mode"]> = "active";
      let renewals = 0;
      let cancellations = 0;
      let confirmedCancellations = 0;
      let deliveryAllowed = true;
      let state: DispatchStore.DispatchState = "running";
      let reason: string | null = null;
      const run: DispatchStore.DispatchRun = {
        run: {
          id: "workflow-run",
          factoryId: "factory",
          workItemId: "work",
          workflowVersionId: "workflow",
          factoryVersionId: "factory-version",
          repository: "fixture",
          revision: "pinned",
          state: "pending",
        },
        workflow: {
          id: "workflow",
          factoryId: "factory",
          factoryVersionId: "factory-version",
          steps: [
            { id: "first", kind: "agent", prompt: "fixture", dependsOn: [] },
            { id: "next", kind: "agent", prompt: "successor", dependsOn: ["first"] },
          ],
        },
        workerId: proof.identity.deviceId,
        binding: {
          identity: proof.identity,
          projectId: ProjectId.make("own-fixture-project"),
          model: "fixture",
          checks: [],
          requiredArtifacts: [{ stepId: "first", names: [artifact.name] }],
        },
        state,
        reason,
        attempts,
      };
      const unsupported = Effect.die("Unexpected fixture operation");
      const store = DispatchStore.DispatchStore.of({
        archiveCursor: () => Effect.succeed(0),
        projectQuestions: () => Effect.void,
        answers: () => Effect.succeed([]),
        answerDelivered: () => Effect.void,
        startManual: () => unsupported,
        permitted: () => Effect.succeed(false),
        admission: () => unsupported,
        canLaunch: () => Effect.succeed(mode === "active"),
        beginDelivery: () => Effect.succeed(mode === "active" && deliveryAllowed),
        approved: () => Effect.succeed(false),
        completeApproval: () => unsupported,
        confirmCancel: () =>
          Effect.sync(() => {
            confirmedCancellations++;
            return true;
          }),
        enroll: () => unsupported,
        read: () => Effect.succeed({ ...run, state, reason, attempts: [...attempts] }),
        claimNext: ({ owner }) =>
          Effect.sync(() => ({
            ...run,
            mode,
            state,
            reason,
            attempts: [...attempts],
            owner,
            generation: ++generation,
          })),
        prepare: (_claim, input) =>
          Effect.sync(() => {
            const attempt: DispatchStore.DispatchAttempt = {
              ...input,
              state: "pending",
              reason: null,
              receipt: null,
              result: null,
            };
            attempts.push(attempt);
            return attempt;
          }),
        record: (_claim, input) =>
          Effect.sync(() => {
            const index = attempts.findIndex((attempt) => attempt.commandId === input.commandId);
            attempts[index] = { ...attempts[index]!, ...input };
            return true;
          }),
        wait: (_claim, next) =>
          Effect.sync(() => {
            state = "waiting";
            reason = next;
            return true;
          }),
        release: () => Effect.void,
      });
      const worker = WorkerTransport.WorkerTransport.of({
        cancel: (_identity, input) =>
          Effect.sync(() => {
            cancellations++;
            const execution = executions.get(input.launchCommandId)!;
            return {
              commandId: input.commandId,
              launch: execution.receipt,
              runId: execution.run.id,
              status: "requested" as const,
              sequence: 2,
            };
          }),
        answer: () => unsupported,
        identityForWrite: () => Effect.succeed(proof.identity),
        identityForRead: () => Effect.succeed(proof.identity),
        authorize: () => Effect.succeed(proof.identity),
        status: () =>
          Effect.succeed({
            online: true,
            providerInstanceId: ProviderInstanceId.make("fixture"),
            providerReady: true,
            providerState: "ready",
            version: "fixture",
            checkedAt: "2026-11-03T20:00:00Z",
            capacityAvailable: true,
            activeRuns: 0,
          }),
        read: (_identity, input) => Effect.sync(() => executions.get(input.commandId) ?? null),
        renew: () =>
          Effect.sync(() => {
            renewals++;
          }),
        launch: (_identity, input) =>
          Effect.gen(function* () {
            launches.push(input);
            const execution = {
              ...proof.execution,
              receipt: { ...proof.execution.receipt, commandId: input.commandId },
              lifecycle: {
                ...proof.execution.lifecycle!,
                writerEnded: false,
                manifest: null,
                state: "active" as const,
              },
            };
            executions.set(input.commandId, execution);
            if (launches.length === 1)
              return yield* new WorkerTransport.WorkerTransportError({ reason: "unavailable" });
            return execution.receipt;
          }),
      });
      const archive = ThreadArchive.ThreadArchive.of({
        ingest: () => unsupported,
        list: () => unsupported,
        cursor: () => Effect.succeed(proof.archive),
        read: () => Effect.succeed({ ...proof.archive, events: proof.events, nextCursor: null }),
      });
      const artifacts = Artifacts.Artifacts.of({
        begin: () => unsupported,
        status: () =>
          Effect.succeed({
            reference: artifact.reference,
            state: "published",
            offset: artifact.sizeBytes,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
          }),
        write: () => unsupported,
        publish: () => unsupported,
        abort: () => unsupported,
        metadata: () => unsupported,
        read: () =>
          artifactMode === "missing"
            ? Effect.fail(new FoundryArtifactError({ code: "unavailable" }))
            : Effect.succeed({
                offset: 0,
                total: artifact.sizeBytes,
                fileSha256: artifact.sha256,
                sha256: artifact.sha256,
                data:
                  artifactMode === "changed"
                    ? "UTE5IHJlcXVpcmVkIGFydGlmYWN0Cg=="
                    : "UDE5IHJlcXVpcmVkIGFydGlmYWN0Cg==",
              }),
        list: () => Effect.succeed({ items: [artifact], nextCursor: null }),
      });
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        assert.isTrue(yield* scheduler.tick);
        assert.equal(launches.length, 1);
        assert.equal(attempts[0]?.receipt, null);
        assert.isTrue(yield* scheduler.tick);
        assert.equal(launches.length, 1);
        assert.equal(attempts[0]?.state, "running");
        assert.equal(attempts[0]?.reason, "writer_end_pending");
        const renewalsBeforePause = renewals;
        mode = "paused";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(renewals, renewalsBeforePause + 1);
        assert.equal(launches.length, 1);
        mode = "active";
        const commandId = launches[0]!.commandId;
        const accepted = executions.get(commandId)!;
        executions.set(commandId, {
          ...proof.execution,
          receipt: accepted.receipt,
          lifecycle: { ...proof.execution.lifecycle!, generation: 2 },
        });
        assert.isTrue(yield* scheduler.tick);
        assert.equal(reason, "execution_binding_mismatch");
        assert.equal(attempts[0]?.state, "running");
        executions.set(commandId, {
          ...proof.execution,
          receipt: accepted.receipt,
          lifecycle: {
            ...proof.execution.lifecycle!,
            manifest: {
              ...proof.execution.lifecycle!.manifest!,
              archive: { ...proof.execution.lifecycle!.manifest!.archive!, deviceGeneration: 2 },
            },
          },
        });
        assert.isTrue(yield* scheduler.tick);
        assert.equal(reason, "archive_binding_mismatch");
        assert.equal(launches.length, 1);
        executions.set(commandId, { ...proof.execution, receipt: accepted.receipt });
        assert.isTrue(yield* scheduler.tick);
        assert.equal(reason, "reconciliation_pending");
        assert.notEqual(attempts[0]?.state, "succeeded");
        assert.equal(launches.length, 1);
        artifactMode = "changed";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(attempts[0]?.reason, "artifacts_pending");
        assert.equal(launches.length, 1);
        artifactMode = "ready";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(attempts[0]?.state, "succeeded");
        assert.equal(launches.length, 1);
        mode = "paused";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(launches.length, 1);
        mode = "active";
        artifactMode = "changed";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(reason, "handoff_artifact_pending");
        assert.equal(launches.length, 1);
        artifactMode = "ready";
        deliveryAllowed = false;
        assert.isTrue(yield* scheduler.tick);
        assert.equal(launches.length, 1);
        assert.equal(reason, "approval_revision_changed");
        deliveryAllowed = true;
        assert.isTrue(yield* scheduler.tick);
        assert.equal(launches.length, 2);
        assert.notEqual(launches[1]?.commandId, commandId);
        assert.deepEqual(launches[1]?.previousExecution, { commandId, generation: 1 });
        assert.deepEqual(launches[1]?.inputArtifacts, [artifact]);
        mode = "cancel_requested";
        assert.isTrue(yield* scheduler.tick);
        assert.equal(cancellations, 1);
        assert.equal(confirmedCancellations, 0);
        const second = executions.get(launches[1]!.commandId)!;
        executions.set(second.receipt.commandId, {
          ...second,
          run: { ...second.run, status: "cancelled" },
          lifecycle: {
            ...proof.execution.lifecycle!,
            state: "stopped",
            manifest: { ...proof.execution.lifecycle!.manifest!, outcome: "stopped" },
          },
        });
        assert.isTrue(yield* scheduler.tick);
        assert.equal(confirmedCancellations, 1);
        assert.equal(attempts[1]?.state, "failed");
        assert.equal(launches.length, 2);
      }).pipe(
        Effect.provide(
          Scheduler.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(DispatchStore.DispatchStore, store),
                Layer.succeed(WorkerTransport.WorkerTransport, worker),
                Layer.succeed(ThreadArchive.ThreadArchive, archive),
                Layer.succeed(Artifacts.Artifacts, artifacts),
                Layer.succeed(Scheduler.SchedulerConfig, {
                  deviceId: proof.identity.deviceId,
                  environmentId: proof.identity.environmentId,
                  allowedRunIds: [run.run.id],
                }),
                NodeCrypto.layer,
              ),
            ),
          ),
        ),
      );
    }),
);

it("rejects ambiguous configured checks and required artifact lists", () => {
  const input = {
    factoryId: "fixture",
    runId: "fixture",
    projectId: ProjectId.make("own-fixture-project"),
    model: "fixture",
    checks: [],
    requiredArtifacts: [],
  };
  const check = {
    id: "check",
    prompt: "Run configured check",
    command: "fixture-check",
    cwd: "/isolated/project",
  };
  const requirement = { stepId: "first", names: ["handoff.txt"] };
  const decode = Schema.decodeSync(Scheduler.EnrollDispatch);
  for (const invalid of [
    { ...input, checks: [check, { ...check, command: "different-check" }] },
    {
      ...input,
      requiredArtifacts: [requirement, { ...requirement, names: ["additional-required.txt"] }],
    },
    { ...input, requiredArtifacts: [{ ...requirement, names: ["handoff.txt", "handoff.txt"] }] },
  ])
    assert.throws(() => decode(invalid));
});
