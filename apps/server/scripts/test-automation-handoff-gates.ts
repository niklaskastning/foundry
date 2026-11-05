// @effect-diagnostics nodeBuiltinImport:off -- These assertions exercise an isolated PostgreSQL cluster owned by the parent harness.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  CommandId,
  FoundryDeviceId,
  EnvironmentId,
  ProjectId,
  AutomationHandoffCommand,
  FoundryWorkerExecution,
  FoundryWorkerHandoffReceipt,
  FoundryWorkerHandoffResult,
} from "@t3tools/contracts";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Handoffs from "../src/automation/Handoffs.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as Control from "../src/automation/Control.ts";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as Artifacts from "../src/foundry/Artifacts.ts";
import * as ThreadArchive from "../src/foundry/ThreadArchive.ts";

const decodeBinding = Schema.decodeEffect(Scheduler.DispatchBinding);
const decodeReceipt = Schema.decodeEffect(FoundryWorkerHandoffReceipt);
const decodeResult = Schema.decodeEffect(FoundryWorkerHandoffResult);
const decodeExecution = Schema.decodeEffect(FoundryWorkerExecution);
const decodeCommand = Schema.decodeEffect(AutomationHandoffCommand);
const decodeUnknownCommand = Schema.decodeUnknownEffect(AutomationHandoffCommand);

export const handoffGates = Effect.fn("Handoffs.postgresGates")(function <E, E2>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
  restart: Effect.Effect<void, E2>,
) {
  return Effect.gen(function* () {
    const testDatabase = database.pipe(Layer.orDie);
    const binding = yield* decodeBinding({
      identity: {
        instanceId: "11111111-1111-4111-8111-111111111151",
        operatorId: "handoff-owner",
        deviceId: "22222222-2222-4222-8222-222222222251",
        environmentId: "handoff-worker",
        deviceGeneration: 1,
        accessGeneration: 1,
        automationGeneration: 1,
        clientSessionId: "handoff-session",
        foundrySessionHash: "h".repeat(43),
      },
      projectId: "handoff-project",
      model: "replay",
      checks: [],
      requiredArtifacts: [],
    });
    const receipt = yield* decodeReceipt({
      handoffId: "p51-handoff",
      threadId: "handoff-thread",
      projectId: "handoff-project",
      workspacePath: "/isolated/p51",
      branch: "handoff-branch",
      baseCommit: "a".repeat(40),
      baseCheckpointRef: "refs/t3/p51",
      sourceThreadId: "source-thread",
      mode: "branch",
    });
    const bytes = Buffer.from("isolated bundle fixture");
    const result = yield* decodeResult({
      receipt,
      commitSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      checkpointRef: "refs/t3/p51-return",
      tests: "User reported local checks",
      openPoints: "Review required",
      bundle: {
        reference: {
          instanceId: binding.identity.instanceId,
          artifactId: "33333333-3333-4333-8333-333333333351",
          owner: { environmentId: binding.identity.environmentId, threadId: receipt.threadId },
        },
        name: "handoff.bundle",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.length,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      },
      archive: {
        instanceId: binding.identity.instanceId,
        deviceId: binding.identity.deviceId,
        deviceGeneration: 1,
        owner: { environmentId: binding.identity.environmentId, threadId: receipt.threadId },
        cursor: 3,
        sourceSequence: 3,
      },
    });
    const source = yield* decodeExecution({
      receipt: {
        commandId: "p51-source",
        threadId: "source-thread",
        acceptedAt: "2026-11-05T00:00:00.000Z",
        sequence: 1,
      },
      run: { id: "p51-t3-run", status: "completed", checkpointId: "p51-checkpoint" },
      lifecycle: {
        generation: 1,
        expiresAt: 0,
        state: "completed",
        writerEnded: true,
        manifest: {
          generation: 1,
          runId: "p51-t3-run",
          checkpointId: "p51-checkpoint",
          checkpointRef: "refs/t3/p51",
          outcome: "completed",
        },
      },
    });
    let expectedIdentity = binding.identity;
    let expectedProjectId = binding.projectId;
    let allowed = true;
    let generation = 1;
    let loseOpenAck = true;
    let finishAvailable = false;
    let archiveComplete = false;
    let rejectReopen = false;
    let revokeOnArchive = false;
    const acceptedOpens = new Set<string>();
    let deliveries = 0;
    const worker = Layer.mock(WorkerTransport.WorkerTransport)({
      identityForRead: () => Effect.succeed(binding.identity),
      identityForWrite: () =>
        allowed
          ? Effect.succeed(binding.identity)
          : Effect.fail(new WorkerTransport.WorkerTransportError({ reason: "forbidden" })),
      authorize: (_request, target) =>
        allowed
          ? Effect.succeed({
              ...(target.deviceId === expectedIdentity.deviceId
                ? expectedIdentity
                : binding.identity),
              accessGeneration: generation,
            })
          : Effect.fail(new WorkerTransport.WorkerTransportError({ reason: "forbidden" })),
      handoffOpen: Effect.fn("Handoffs.fixtureOpen")(function* (inputIdentity, input) {
        NodeAssert.equal(inputIdentity.deviceId, expectedIdentity.deviceId);
        NodeAssert.equal(input.projectId, expectedProjectId);
        deliveries++;
        acceptedOpens.add(input.commandId);
        if (loseOpenAck)
          return yield* new WorkerTransport.WorkerTransportError({ reason: "unavailable" });
        return {
          ...receipt,
          projectId: input.projectId,
          handoffId: input.handoffId,
          mode: input.mode,
        };
      }),
      handoffFinish: () =>
        finishAvailable
          ? Effect.succeed(result)
          : Effect.fail(new WorkerTransport.WorkerTransportError({ reason: "unavailable" })),
      handoffReopen: () =>
        rejectReopen
          ? Effect.fail(
              new WorkerTransport.WorkerTransportError({
                reason: "worker_rejected",
                handoffCode: "conflict",
              }),
            )
          : Effect.succeed(receipt),
    });
    const services = Layer.mergeAll(Handoffs.layer, Control.layer).pipe(
      Layer.provideMerge(DispatchStore.layer),
      Layer.provideMerge(Workflows.layer),
      Layer.provideMerge(Factories.layer),
      Layer.provide(testDatabase),
      Layer.provide(Crypto.layer),
      Layer.provide(worker),
      Layer.provide(
        Layer.succeed(Scheduler.SchedulerConfig, {
          deviceId: binding.identity.deviceId,
          environmentId: binding.identity.environmentId,
          allowedRunIds: [],
        }),
      ),
      Layer.provide(
        Layer.mock(Artifacts.Artifacts)({
          metadata: () => Effect.succeed(result.bundle),
          read: (_identity, input) =>
            Effect.succeed({
              reference: input.reference,
              offset: input.offset,
              total: bytes.length,
              fileSha256: result.bundle.sha256,
              sha256: result.bundle.sha256,
              data: bytes.toString("base64"),
              nextOffset: null,
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadArchive.ThreadArchive)({
          cursor: () =>
            Effect.sync(() => {
              if (revokeOnArchive) allowed = false;
              return {
                owner: result.archive.owner,
                confirmedCursor: 3,
                confirmedSourceSequence: 3,
                sourceHead: 3,
                sourceComplete: archiveComplete,
                complete: archiveComplete,
                missingArtifacts: [],
                missingAttachmentCount: 0,
              };
            }),
        }),
      ),
    );
    const request = HttpServerRequest.fromWeb(new Request("https://fixture.invalid"));
    const execute = (input: AutomationHandoffCommand) =>
      Handoffs.Handoffs.pipe(
        Effect.flatMap((s) => s.execute(request, input)),
        Effect.provide(services),
      );
    const query = <A, E3>(
      f: (sql: Database.AutomationDatabase["Service"]) => Effect.Effect<A, E3>,
    ) => Database.AutomationDatabase.pipe(Effect.flatMap(f), Effect.provide(testDatabase));
    const state = () =>
      Handoffs.Handoffs.pipe(
        Effect.flatMap((s) =>
          s.query(request, { op: "handoffs", factoryId: "p51-factory", workItemId: "p51-work" }),
        ),
        Effect.provide(services),
      );
    const failure = <A, E3, R>(effect: Effect.Effect<A, E3, R>) =>
      effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
    yield* Effect.gen(function* () {
      const factories = yield* Factories.Factories;
      const workflows = yield* Workflows.Workflows;
      const dispatch = yield* DispatchStore.DispatchStore;
      yield* factories.createFactory({
        commandId: "p51-factory",
        id: "p51-factory",
        name: "P51 isolated fixture",
      });
      yield* factories.createVersion({
        commandId: "p51-version",
        id: "p51-version",
        factoryId: "p51-factory",
        repositories: ["p51-repo"],
      });
      yield* factories.createWorkItem({
        commandId: "p51-work",
        id: "p51-work",
        factoryId: "p51-factory",
        versionId: "p51-version",
        repository: "p51-repo",
        title: "P51 isolated work",
        source: { kind: "manual", reference: "fixture" },
      });
      yield* workflows.createVersion({
        commandId: "p51-workflow",
        id: "p51-workflow",
        factoryId: "p51-factory",
        factoryVersionId: "p51-version",
        steps: [
          { id: "implementation", kind: "agent", prompt: "fixture", dependsOn: [] },
          {
            id: "review",
            kind: "approval",
            prompt: "Review fixture",
            dependsOn: ["implementation"],
          },
          { id: "publish", kind: "publish", target: "pull_request", dependsOn: ["review"] },
        ],
      });
      yield* workflows.start({
        commandId: "p51-start",
        id: "p51-run",
        factoryId: "p51-factory",
        workItemId: "p51-work",
        workflowVersionId: "p51-workflow",
        revision: "original-input",
      });
      yield* dispatch.enroll({
        factoryId: "p51-factory",
        runId: "p51-run",
        workerId: binding.identity.deviceId,
        binding,
      });
      yield* dispatch.admission("p51-run", "p51-start", binding.identity);
    }).pipe(Effect.provide(services));
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,result) VALUES('p51-source','p51-run',0,${sql.json({ commandId: CommandId.make("p51-source"), projectId: binding.projectId, model: "replay", title: "fixture", prompt: "fixture" })},'succeeded',${sql.json({ execution: source, artifacts: [] })})`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.dispatch_outbox(command_id,state) VALUES('p51-source','confirmed')`,
    );
    const take = yield* decodeCommand({
      op: "takeOver",
      commandId: "p51-take",
      id: "p51-handoff",
      factoryId: "p51-factory",
      runId: "p51-run",
      expectedRevision: 0,
      sourceCommandId: "p51-source",
      mode: "branch",
    });
    NodeAssert.equal((yield* failure(execute(take)))?.code, "writer_not_ended");
    yield* query(
      (sql) => sql`UPDATE foundry_automation.run_controls SET mode='paused' WHERE run_id='p51-run'`,
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.step_attempts SET result=NULL WHERE command_id='p51-source'`,
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.dispatch_outbox SET state='sending' WHERE command_id='p51-source'`,
    );
    NodeAssert.equal((yield* failure(execute(take)))?.code, "writer_not_ended");
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.step_attempts SET result=${sql.json({ execution: source, artifacts: [] })} WHERE command_id='p51-source'`,
    );
    yield* Effect.gen(function* () {
      const factories = yield* Factories.Factories;
      const workflows = yield* Workflows.Workflows;
      const dispatch = yield* DispatchStore.DispatchStore;
      yield* workflows.start({
        commandId: "p51-parallel-start",
        id: "p51-parallel-run",
        factoryId: "p51-factory",
        workItemId: "p51-work",
        workflowVersionId: "p51-workflow",
        revision: "parallel-input",
      });
      yield* dispatch.enroll({
        factoryId: "p51-factory",
        runId: "p51-parallel-run",
        workerId: binding.identity.deviceId,
        binding,
      });
      yield* factories.createWorkItem({
        commandId: "p51-other-work",
        id: "p51-other-work",
        factoryId: "p51-factory",
        versionId: "p51-version",
        repository: "p51-repo",
        title: "Other isolated work",
        source: { kind: "manual", reference: "fixture" },
      });
      yield* workflows.start({
        commandId: "p51-other-start",
        id: "p51-other-run",
        factoryId: "p51-factory",
        workItemId: "p51-other-work",
        workflowVersionId: "p51-workflow",
        revision: "other-input",
      });
      yield* dispatch.enroll({
        factoryId: "p51-factory",
        runId: "p51-other-run",
        workerId: binding.identity.deviceId,
        binding,
      });
    }).pipe(Effect.provide(services));
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.run_controls SET mode='paused' WHERE run_id='p51-parallel-run'`,
    );
    NodeAssert.equal(
      (yield* failure(execute(take)))?.code,
      "writer_not_ended",
      "A paused sibling run must not survive ownership transfer",
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.run_controls SET mode='cancelled' WHERE run_id='p51-parallel-run'`,
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.dispatch_runs SET state='failed' WHERE run_id='p51-parallel-run'`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state) VALUES('p51-other-source','p51-other-run',0,${sql.json({ commandId: CommandId.make("p51-other-source"), projectId: binding.projectId, model: "replay", title: "other fixture", prompt: "fixture" })},'running')`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.dispatch_outbox(command_id,state) VALUES('p51-other-source','delivered')`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,result) VALUES('p51-review','p51-run',1,${sql.json({ kind: "approval" })},'succeeded',NULL),('p51-publish','p51-run',2,${sql.json({ kind: "publish" })},'succeeded',${sql.json({ publish: { number: 1, url: "https://fixture.invalid/pull/1", commitSha: "a".repeat(40), operationKey: "p51-publish" } })})`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.dispatch_outbox(command_id,state) VALUES('p51-review','confirmed'),('p51-publish','confirmed')`,
    );
    NodeAssert.equal(
      (yield* failure(execute(take)))?.code,
      "writer_not_ended",
      "Another work item's writer must retain scheduler renewal",
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.step_attempts SET state='succeeded',result=${sql.json({ execution: source, artifacts: [] })} WHERE command_id='p51-other-source'`,
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.dispatch_runs SET state='succeeded' WHERE run_id='p51-other-run'`,
    );
    const staleClaim = yield* DispatchStore.DispatchStore.pipe(
      Effect.flatMap((s) =>
        s.claimNext({
          workerId: binding.identity.deviceId,
          owner: "p51-old-claim",
          leaseMillis: 60000,
        }),
      ),
      Effect.provide(services),
    );
    NodeAssert.ok(staleClaim);
    NodeAssert.equal(
      (yield* failure(execute(take)))?.code,
      "unavailable",
      "Confirmed approval and publish records have no writer and must allow worker delivery",
    );
    NodeAssert.equal((yield* state())[0]?.state, "opening");
    NodeAssert.deepEqual((yield* state())[0]?.pendingCommands, [take]);
    yield* restart;
    loseOpenAck = false;
    const opened = yield* execute(take);
    NodeAssert.equal(opened.state, "open");
    NodeAssert.equal(
      (yield* failure(
        execute({
          op: "takeOver",
          commandId: "p51-other-take",
          id: "p51-other-handoff",
          factoryId: "p51-factory",
          runId: "p51-other-run",
          expectedRevision: 0,
          sourceCommandId: "p51-other-source",
          mode: "existing",
        }),
      ))?.code,
      "conflict",
      "One worker must not admit parallel interactive handoffs",
    );
    NodeAssert.equal(deliveries, 2);
    NodeAssert.equal(acceptedOpens.size, 1, "Lost ack must reuse the same worker command");
    NodeAssert.equal(
      yield* DispatchStore.DispatchStore.pipe(
        Effect.flatMap((s) => s.canLaunch(staleClaim)),
        Effect.provide(services),
      ),
      false,
    );
    NodeAssert.equal(
      yield* DispatchStore.DispatchStore.pipe(
        Effect.flatMap((s) =>
          s.claimNext({
            workerId: binding.identity.deviceId,
            owner: "p51-new-claim",
            leaseMillis: 60000,
          }),
        ),
        Effect.provide(services),
      ),
      null,
    );
    const forbiddenStart = yield* failure(
      Workflows.Workflows.pipe(
        Effect.flatMap((s) =>
          s.start({
            commandId: "p51-forbidden-start",
            id: "p51-forbidden-run",
            factoryId: "p51-factory",
            workItemId: "p51-work",
            workflowVersionId: "p51-workflow",
            revision: "unsafe",
          }),
        ),
        Effect.provide(services),
      ),
    );
    NodeAssert.ok(forbiddenStart);
    const back = yield* decodeCommand({
      op: "returnHandoff",
      commandId: "p51-return-old",
      factoryId: "p51-factory",
      handoffId: opened.id,
      expectedGeneration: 0,
      expectedBaseCommit: receipt.baseCommit,
      tests: result.tests,
      openPoints: result.openPoints,
    });
    NodeAssert.equal((yield* failure(execute(back)))?.code, "unavailable");
    NodeAssert.equal((yield* state())[0]?.state, "returning");
    const reopened = yield* execute({
      op: "reopenHandoff",
      commandId: "p51-reopen",
      factoryId: "p51-factory",
      handoffId: opened.id,
      expectedGeneration: 0,
    });
    NodeAssert.equal(reopened.generation, 1);
    NodeAssert.deepEqual(reopened.pendingCommands, []);
    NodeAssert.equal((yield* failure(execute(back)))?.code, "conflict");
    const returnedInput = yield* decodeUnknownCommand({
      ...back,
      commandId: "p51-return",
      expectedGeneration: 1,
    });
    allowed = false;
    NodeAssert.equal((yield* failure(execute(returnedInput)))?.code, "forbidden");
    allowed = true;
    generation = 2;
    NodeAssert.equal((yield* failure(execute(returnedInput)))?.code, "forbidden");
    generation = 1;
    finishAvailable = true;
    NodeAssert.equal((yield* failure(execute(returnedInput)))?.code, "archive_missing");
    NodeAssert.equal((yield* state())[0]?.continuationRunId, null);
    rejectReopen = true;
    const rejectedReopen = {
      op: "reopenHandoff" as const,
      commandId: "p51-reopen-after-worker-return",
      factoryId: "p51-factory",
      handoffId: opened.id,
      expectedGeneration: 1,
    };
    NodeAssert.equal((yield* failure(execute(rejectedReopen)))?.code, "conflict");
    NodeAssert.deepEqual(
      new Set((yield* state())[0]?.pendingCommands.map((command) => command.commandId)),
      new Set([returnedInput.commandId, rejectedReopen.commandId]),
      "A rejected reopen must not hide recovery of the original return",
    );
    archiveComplete = true;
    revokeOnArchive = true;
    NodeAssert.equal(
      (yield* failure(execute(returnedInput)))?.code,
      "forbidden",
      "Rights revoked during archive confirmation must block the central commit",
    );
    revokeOnArchive = false;
    allowed = true;
    const returned = yield* execute(returnedInput);
    NodeAssert.equal(returned.state, "returned");
    NodeAssert.equal(returned.generation, 2);
    NodeAssert.deepEqual(yield* execute(returnedInput), returned);
    const continuation = yield* Workflows.Workflows.pipe(
      Effect.flatMap((s) => s.readRun("p51-factory", returned.continuationRunId!)),
      Effect.provide(services),
    );
    NodeAssert.equal(continuation.state, "paused");
    NodeAssert.equal(continuation.workItemId, "p51-work");
    NodeAssert.equal(continuation.revision, result.commitSha);
    const original = yield* Workflows.Workflows.pipe(
      Effect.flatMap((s) => s.readRun("p51-factory", "p51-run")),
      Effect.provide(services),
    );
    NodeAssert.equal(original.revision, "original-input");
    const oldResume = yield* failure(
      Control.Control.pipe(
        Effect.flatMap((s) =>
          s.execute(request, {
            commandId: "p51-old-resume",
            factoryId: "p51-factory",
            runId: "p51-run",
            expectedRevision: 2,
            action: "resume",
          }),
        ),
        Effect.provide(services),
      ),
    );
    NodeAssert.equal(oldResume?.code, "invalid_transition");
    const threadLink = yield* Handoffs.Handoffs.pipe(
      Effect.flatMap((s) =>
        s.query(request, {
          op: "threadHandoff",
          environmentId: binding.identity.environmentId,
          threadId: receipt.threadId,
        }),
      ),
      Effect.provide(services),
    );
    NodeAssert.equal(threadLink[0]?.workItemId, "p51-work");
    expectedIdentity = {
      ...binding.identity,
      deviceId: FoundryDeviceId.make("44444444-4444-4444-8444-444444444451"),
      environmentId: EnvironmentId.make("handoff-second-worker"),
    };
    expectedProjectId = ProjectId.make("second-worker-project");
    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      const dispatch = yield* DispatchStore.DispatchStore;
      yield* workflows.createVersion({
        commandId: "p29-handoff-workflow",
        id: "p29-handoff-workflow",
        factoryId: "p51-factory",
        factoryVersionId: "p51-version",
        execution: {
          mode: "parallel",
          maxParallelism: 2,
          maxRepairRounds: 1,
          join: "all_succeeded",
          failurePolicy: "repair_failed",
          joinStepId: "join",
        },
        steps: [
          { id: "left", kind: "agent", dependsOn: [], prompt: "Left" },
          { id: "right", kind: "agent", dependsOn: [], prompt: "Right" },
          { id: "join", kind: "agent", dependsOn: ["left", "right"], prompt: "Join" },
        ],
      });
      yield* workflows.start({
        commandId: "p29-handoff-start",
        id: "p29-handoff-run",
        factoryId: "p51-factory",
        workItemId: "p51-other-work",
        workflowVersionId: "p29-handoff-workflow",
        revision: "a".repeat(40),
      });
      yield* dispatch.enroll({
        factoryId: "p51-factory",
        runId: "p29-handoff-run",
        workerId: binding.identity.deviceId,
        binding,
      });
    }).pipe(Effect.provide(services));
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.run_controls SET mode='paused' WHERE run_id='p29-handoff-run'`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,result,worker_id,worker_binding) VALUES('p29-assigned-source','p29-handoff-run',0,'{}','succeeded',${sql.json({ execution: source, artifacts: [] })},${expectedIdentity.deviceId},${sql.json({ identity: expectedIdentity, projectId: expectedProjectId })})`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.dispatch_outbox(command_id,state) VALUES('p29-assigned-source','confirmed')`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request,state,worker_id) VALUES('p51-running-sibling','p29-handoff-run',1,'{}','running',${binding.identity.deviceId})`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.dispatch_outbox(command_id,state) VALUES('p51-running-sibling','delivered')`,
    );
    const assignedTake = yield* decodeCommand({
      op: "takeOver",
      commandId: "p29-assigned-take",
      id: "p29-assigned-handoff",
      factoryId: "p51-factory",
      runId: "p29-handoff-run",
      expectedRevision: 0,
      sourceCommandId: "p29-assigned-source",
      mode: "existing",
    });
    NodeAssert.equal(
      (yield* failure(execute(assignedTake)))?.code,
      "writer_not_ended",
      "A stopped source cannot hide a live sibling on another worker",
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.step_attempts SET state='succeeded',result=${sql.json({ execution: source, artifacts: [] })} WHERE command_id='p51-running-sibling'`,
    );
    const assignedHandoff = yield* execute(assignedTake);
    NodeAssert.equal(assignedHandoff.environmentId, expectedIdentity.environmentId);
    NodeAssert.equal(assignedHandoff.receipt?.projectId, expectedProjectId);
    NodeAssert.deepEqual(yield* execute(assignedTake), assignedHandoff);
  });
});
