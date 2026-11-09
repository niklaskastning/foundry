// @effect-diagnostics nodeBuiltinImport:off -- Assertions exercise the isolated PostgreSQL fixture.
import { v4McpGates } from "./test-automation-v4-mcp-gates.ts";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { validateFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Inbox from "../src/automation/Inbox.ts";
import * as Control from "../src/automation/Control.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import type { FactoryV4Workflow } from "@t3tools/contracts";
import { DispatchBinding } from "../src/automation/Scheduler.ts";
import { stringify } from "yaml";

const decodeBinding = Schema.decodeEffect(DispatchBinding);

export const v4Gates = Effect.fn("V4.postgresGates")(function* <E, E2>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
  restart: Effect.Effect<void, E2>,
) {
  yield* v4McpGates(database);
  const services = DispatchStore.layer.pipe(
    Layer.provideMerge(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
    Layer.provideMerge(database),
  );
  const call = <A, E3>(
    fn: (store: DispatchStore.DispatchStore["Service"]) => Effect.Effect<A, E3>,
  ) => DispatchStore.DispatchStore.pipe(Effect.flatMap(fn), Effect.provide(services));
  const parsed = validateFactoryFiles([
    {
      path: "factory.yaml",
      content: stringify({
        schemaVersion: 4,
        factoryId: "v4",
        repositories: ["fixture"],
        workflows: [{ id: "review", file: "workflows/review.yaml" }],
        agents: [{ id: "worker", file: "agents/worker.yaml" }],
        skills: [],
        mcp: [],
      }),
    },
    {
      path: "agents/worker.yaml",
      content: stringify({
        id: "worker",
        name: "Worker",
        description: "Fixture",
        instructions: "Run fixture",
        skills: [],
        mcp: [],
      }),
    },
    {
      path: "workflows/review.yaml",
      content: stringify({
        id: "review",
        limits: { maxConcurrentAgents: 2, maxAgentExecutions: 4 },
        steps: [
          {
            id: "improve",
            kind: "loop",
            dependsOn: [],
            maxIterations: 2,
            onExhausted: "fail",
            carry: { feedback: { value: "implement" } },
            nextCarry: { feedback: { ref: "steps.review.output.feedback" } },
            until: { eq: [{ ref: "steps.review.output.verdict" }, { value: "approved" }] },
            steps: [
              {
                id: "implement",
                kind: "agent",
                agent: "worker",
                instructions: "Implement",
                dependsOn: [],
                workspace: { access: "write" },
                inputs: { feedback: { ref: "carry.feedback" } },
              },
              {
                id: "review",
                kind: "agent",
                agent: "worker",
                instructions: "Review",
                dependsOn: ["implement"],
                workspace: {
                  access: "read",
                  from: { ref: "steps.implement.artifacts.checkpoint" },
                },
                resultSchema: {
                  type: "object",
                  properties: {
                    verdict: { type: "string", enum: ["approved", "changes_requested"] },
                    feedback: { type: "string", maxLength: 100 },
                  },
                  required: ["verdict", "feedback"],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      }),
    },
  ]);
  NodeAssert.equal(parsed._tag, "Success");
  if (parsed._tag !== "Success" || parsed.success.schemaVersion !== 4)
    throw new Error("Invalid fixture");
  const definition = parsed.success;
  const pinned = {
    workflow: definition.workflows[0]!,
    agents: definition.agents,
    skills: definition.skills,
    mcp: definition.mcp,
    files: definition.files,
  };
  yield* Effect.gen(function* () {
    const factories = yield* Factories.Factories;
    const workflows = yield* Workflows.Workflows;
    yield* factories.createFactory({ commandId: "v4-factory", id: "v4", name: "V4" });
    yield* factories.createVersion({
      commandId: "v4-version",
      id: "v4-version",
      factoryId: "v4",
      repositories: ["fixture"],
    });
    yield* factories.createWorkItem({
      commandId: "v4-work",
      id: "v4-work",
      factoryId: "v4",
      versionId: "v4-version",
      repository: "fixture",
      title: "V4",
      source: { kind: "manual", reference: "fixture" },
    });
    yield* workflows.createVersion({
      commandId: "v4-flow",
      id: "v4-flow",
      factoryId: "v4",
      factoryVersionId: "v4-version",
      steps: [],
      v4: pinned,
    });
    yield* workflows.start({
      commandId: "v4-run",
      id: "v4-run",
      factoryId: "v4",
      workItemId: "v4-work",
      workflowVersionId: "v4-flow",
      revision: "a".repeat(40),
      inputs: { request: "pinned-input" },
    });
  }).pipe(Effect.provide(services));
  yield* call((store) =>
    store.enroll({ factoryId: "v4", runId: "v4-run", workerId: "v4-worker", binding: {} }),
  );
  const claimed = yield* call((store) =>
    store.claimNext({ workerId: "v4-worker", owner: "v4-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(claimed);
  let claim: DispatchStore.DispatchClaim = claimed;
  const refresh = Effect.fn("V4.refresh")(function* () {
    claim = { ...claim, ...(yield* call((store) => store.reconcileV4(claim))) };
    return claim;
  });
  const prepare = Effect.fn("V4.prepare")(function* (ordinal: number) {
    const commandId = `${claim.run.id}-command-${ordinal}`;
    return yield* call((store) =>
      store.prepare(claim, {
        ordinal,
        commandId,
        request: {
          commandId,
          projectId: "fixture",
          model: "fixture",
          title: "V4 fixture",
          prompt: "Fixture",
        },
        target: { workerId: "v4-leaf", binding: { projectId: "fixture" }, capacity: 2 },
      }),
    );
  });
  const finish = Effect.fn("V4.finish")(function* (
    ordinal: number,
    output?: { verdict: string; feedback: string },
  ) {
    const commandId = `${claim.run.id}-command-${ordinal}`;
    yield* call((store) =>
      store.record(claim, {
        commandId,
        state: "succeeded",
        reason: null,
        receipt: null,
        result: {
          execution: {
            receipt: {
              commandId,
              threadId: `thread-${ordinal}`,
              acceptedAt: "2026-11-05T00:00:00Z",
              sequence: 1,
            },
            run: { id: `run-${ordinal}`, status: "completed", checkpointId: null },
            lifecycle: {
              generation: 1,
              expiresAt: 0,
              state: "stopped",
              writerEnded: true,
              manifest: null,
            },
          },
          checkpoint: {
            commitSha: String(ordinal + 1).repeat(40),
            commandId,
            generation: 1,
            workerId: "v4-leaf",
          },
          ...(output ? { output } : {}),
        },
      }),
    );
    yield* refresh();
  });
  yield* refresh();
  const early = yield* prepare(1).pipe(Effect.result);
  NodeAssert.equal(early._tag, "Failure");
  const duplicate = yield* Effect.all([prepare(0), prepare(0)], { concurrency: 2 });
  NodeAssert.equal(duplicate[0].commandId, duplicate[1].commandId);
  NodeAssert.equal(
    (yield* call((store) => store.read("v4", "v4-run"))).v4State?.startedAgentExecutions,
    1,
  );
  yield* finish(0);
  yield* prepare(1);
  yield* finish(1, { verdict: "changes_requested", feedback: "repair" });
  NodeAssert.equal(
    claim.v4State?.nodes.find((node) => node.path === "improve/iteration-2/implement")?.base,
    "1".repeat(40),
  );
  yield* call((store) => store.release(claim));
  yield* restart;
  const restarted = yield* call((store) =>
    store.claimNext({ workerId: "v4-worker", owner: "v4-restart", leaseMillis: 60000 }),
  );
  NodeAssert.ok(restarted);
  claim = restarted;
  yield* refresh();
  NodeAssert.equal(claim.v4State?.startedAgentExecutions, 2);
  NodeAssert.deepEqual(claim.v4State?.inputs, { request: "pinned-input" });
  NodeAssert.deepEqual(
    claim.v4State?.nodes.find((node) => node.path === "improve/iteration-2/implement")?.inputs,
    { feedback: "repair" },
  );
  const stale = yield* call((store) =>
    store.prepare(claimed, { ordinal: 2, commandId: "stale", request: {} }),
  ).pipe(Effect.result);
  NodeAssert.equal(stale._tag, "Failure");
  yield* prepare(2);
  yield* finish(2);
  yield* prepare(3);
  yield* finish(3, { verdict: "approved", feedback: "done" });
  NodeAssert.equal(claim.state, "succeeded");
  NodeAssert.equal(claim.v4State?.startedAgentExecutions, 4);
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 0);
  const final = yield* call((store) => store.read("v4", "v4-run"));
  NodeAssert.deepEqual(final.workflow.v4, pinned);
  NodeAssert.equal(
    final.v4State?.nodes[0]?.output && typeof final.v4State.nodes[0].output === "object",
    true,
  );
  yield* call((store) => store.release(claim));
  const loop = pinned.workflow.steps[0]!;
  NodeAssert.equal(loop.kind, "loop");
  if (loop.kind !== "loop") throw new Error("Expected fixture loop");
  const changed = {
    ...pinned.workflow,
    steps: [{ ...loop, maxIterations: 1, onExhausted: "approval" as const }],
  };
  const approvalParsed = validateFactoryFiles(
    definition.files.map((file) => ({
      path: file.path,
      content: file.path === "workflows/review.yaml" ? stringify(changed) : file.content,
    })),
  );
  NodeAssert.equal(approvalParsed._tag, "Success");
  if (approvalParsed._tag !== "Success" || approvalParsed.success.schemaVersion !== 4)
    throw new Error("Invalid approval fixture");
  const approvalDefinition = approvalParsed.success;
  const approvalSnapshot = {
    workflow: approvalDefinition.workflows[0]!,
    agents: approvalDefinition.agents,
    skills: approvalDefinition.skills,
    mcp: approvalDefinition.mcp,
    files: approvalDefinition.files,
  };
  const binding = yield* decodeBinding({
    identity: {
      instanceId: "00000000-0000-4000-8000-000000000004",
      operatorId: "v4-owner",
      deviceId: "00000000-0000-4000-8000-000000000005",
      environmentId: "v4-environment",
      deviceGeneration: 1,
      accessGeneration: 1,
      automationGeneration: 1,
      clientSessionId: "v4-session",
      foundrySessionHash: "a".repeat(43),
    },
    projectId: "fixture",
    model: "fixture",
    checks: [],
    requiredArtifacts: [],
  });
  yield* Effect.gen(function* () {
    const workflows = yield* Workflows.Workflows;
    yield* workflows.createVersion({
      commandId: "v4-approval-flow",
      id: "v4-approval-flow",
      factoryId: "v4",
      factoryVersionId: "v4-version",
      steps: [],
      v4: approvalSnapshot,
    });
    yield* workflows.start({
      commandId: "v4-approval",
      id: "v4-approval",
      factoryId: "v4",
      workItemId: "v4-work",
      workflowVersionId: "v4-approval-flow",
      revision: "a".repeat(40),
    });
  }).pipe(Effect.provide(services));
  yield* call((store) =>
    store.enroll({
      factoryId: "v4",
      runId: "v4-approval",
      workerId: "v4-approval-worker",
      binding,
    }),
  );
  const nextClaim = yield* call((store) =>
    store.claimNext({ workerId: "v4-approval-worker", owner: "v4-owner", leaseMillis: 60000 }),
  );
  NodeAssert.ok(nextClaim);
  claim = nextClaim;
  yield* refresh();
  yield* prepare(0);
  yield* finish(0);
  yield* prepare(1);
  yield* finish(1, { verdict: "changes_requested", feedback: "remaining" });
  NodeAssert.equal(claim.state, "waiting");
  const request = HttpServerRequest.fromWeb(new Request("http://localhost"));
  const transport = Layer.mock(WorkerTransport.WorkerTransport)({
    identityForRead: () => Effect.succeed(binding.identity),
    identityForWrite: () => Effect.succeed(binding.identity),
  });
  const inbox = Inbox.layer.pipe(Layer.provide(transport), Layer.provide(database));
  const entries = yield* Inbox.Inbox.pipe(
    Effect.flatMap((inbox) =>
      inbox.query(request, { factoryId: "v4", kind: "approval", status: "open" }),
    ),
    Effect.provide(inbox),
  );
  const pending = entries.items.find(
    (item) => item.runId === claim.run.id && item.stepId === "improve/exhausted-approval",
  );
  NodeAssert.ok(pending);
  yield* Effect.gen(function* () {
    const sql = yield* Database.AutomationDatabase;
    yield* sql`INSERT INTO foundry_automation.inbox_entries(id,instance_id,operator_id,factory_id,work_item_id,run_id,kind,source_revision,source,active)
      SELECT 'legacy-inbox-history',instance_id,operator_id,factory_id,work_item_id,run_id,kind,source_revision,source-'status',false
      FROM foundry_automation.inbox_entries WHERE id=${pending.id}`;
  }).pipe(Effect.provide(database));
  yield* Inbox.Inbox.pipe(
    Effect.flatMap((inbox) =>
      Effect.gen(function* () {
        const history = yield* inbox.query(request, { factoryId: "v4", status: "all" });
        const legacy = history.items.find((item) => item.id === "legacy-inbox-history");
        NodeAssert.ok(legacy);
        NodeAssert.equal(legacy.isDone, false);
        const marked = yield* inbox.mark(request, {
          commandId: "legacy-inbox-read",
          itemId: legacy.id,
          sourceRevision: legacy.sourceRevision,
          action: "read",
        });
        NodeAssert.equal(marked.isRead, true);
        NodeAssert.equal(marked.isDone, false);
      }),
    ),
    Effect.provide(inbox),
  );

  yield* Control.Control.pipe(
    Effect.flatMap((control) =>
      control.execute(request, {
        commandId: "v4-accept-exhausted",
        action: "approve",
        factoryId: "v4",
        runId: claim.run.id,
        stepId: pending.stepId!,
        expectedRevision: pending.expectedRevision,
        resultRevision: pending.resultRevision,
      }),
    ),
    Effect.provide(
      Control.layer.pipe(
        Layer.provide(services),
        Layer.provide(transport),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  );
  yield* refresh();
  const approval = claim.v4State?.nodes.find((node) => node.path === "improve/exhausted-approval");
  NodeAssert.ok(approval?.ordinal !== undefined);
  NodeAssert.equal(
    yield* call((store) => store.completeApproval(claim, approval.ordinal!, "v4-approved")),
    true,
  );
  yield* refresh();
  NodeAssert.equal(claim.state, "succeeded");
  NodeAssert.equal(claim.v4State?.startedAgentExecutions, 2);
  NodeAssert.deepEqual(claim.v4State?.nodes[0]?.output, {
    iterations: 1,
    reason: "accepted",
    last: {
      implement: {
        status: "succeeded",
        artifacts: {
          checkpoint: {
            commitSha: "1".repeat(40),
            commandId: "v4-approval-command-0",
            generation: 1,
            workerId: "v4-leaf",
          },
        },
      },
      review: {
        status: "succeeded",
        output: { verdict: "changes_requested", feedback: "remaining" },
        artifacts: {
          checkpoint: {
            commitSha: "2".repeat(40),
            commandId: "v4-approval-command-1",
            generation: 1,
            workerId: "v4-leaf",
          },
        },
      },
    },
  });
  yield* call((store) => store.release(claim));
  const startVariant = Effect.fn("V4.startVariant")(function* (
    id: string,
    workflow: FactoryV4Workflow,
  ) {
    const parsed = validateFactoryFiles(
      definition.files.map((file) => ({
        path: file.path,
        content: file.path === "workflows/review.yaml" ? stringify(workflow) : file.content,
      })),
    );
    NodeAssert.equal(parsed._tag, "Success");
    if (parsed._tag !== "Success" || parsed.success.schemaVersion !== 4)
      throw new Error("Invalid variant");
    const value = parsed.success;
    yield* Effect.gen(function* () {
      const workflows = yield* Workflows.Workflows;
      yield* workflows.createVersion({
        commandId: `${id}-flow`,
        id: `${id}-flow`,
        factoryId: "v4",
        factoryVersionId: "v4-version",
        steps: [],
        v4: {
          workflow: value.workflows[0]!,
          agents: value.agents,
          skills: value.skills,
          mcp: value.mcp,
          files: value.files,
        },
      });
      yield* workflows.start({
        commandId: id,
        id,
        factoryId: "v4",
        workItemId: "v4-work",
        workflowVersionId: `${id}-flow`,
        revision: "a".repeat(40),
      });
    }).pipe(Effect.provide(services));
    yield* call((store) =>
      store.enroll({ factoryId: "v4", runId: id, workerId: `${id}-worker`, binding }),
    );
    const next = yield* call((store) =>
      store.claimNext({ workerId: `${id}-worker`, owner: "v4-owner", leaseMillis: 60000 }),
    );
    NodeAssert.ok(next);
    claim = next;
    yield* refresh();
  });
  const leaf = (id: string) => ({
    id,
    kind: "agent" as const,
    agent: "worker",
    instructions: id,
    dependsOn: [],
  });
  const failAttempt = Effect.fn("V4.failAttempt")(function* (ordinal: number) {
    const commandId = `${claim.run.id}-command-${ordinal}`;
    yield* call((store) =>
      store.record(claim, {
        commandId,
        state: "failed",
        reason: "worker_failed",
        receipt: null,
        result: {
          execution: {
            receipt: {
              commandId,
              threadId: `thread-${ordinal}`,
              acceptedAt: "2026-11-05T00:00:00Z",
              sequence: 1,
            },
            run: { id: `run-${ordinal}`, status: "failed", checkpointId: null },
            lifecycle: {
              generation: 1,
              expiresAt: 0,
              state: "stopped",
              writerEnded: true,
              manifest: null,
            },
          },
        },
      }),
    );
    yield* refresh();
  });
  yield* startVariant("v4-quorum", {
    id: "review",
    limits: { maxConcurrentAgents: 2, maxAgentExecutions: 4 },
    steps: [
      {
        id: "reviewers",
        kind: "swarm",
        dependsOn: [],
        maxParallel: 2,
        join: { policy: "quorum", minSuccesses: 1, onFailure: "collect" },
        steps: [leaf("left"), leaf("right")],
      },
    ],
  });
  yield* Effect.all([prepare(0), prepare(1)], { concurrency: 2 });
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 2);
  yield* failAttempt(0);
  NodeAssert.equal(claim.state, "running");
  yield* finish(1);
  NodeAssert.equal(claim.state, "succeeded");
  NodeAssert.equal(
    claim.v4State?.nodes.find((node) => node.path === "reviewers")?.status,
    "succeeded",
  );
  NodeAssert.equal(
    claim.v4State?.nodes.find((node) => node.path === "reviewers/left")?.status,
    "failed",
  );
  yield* call((store) => store.release(claim));

  yield* startVariant("v4-cancel-members", {
    id: "review",
    limits: { maxConcurrentAgents: 2, maxAgentExecutions: 4 },
    steps: [
      {
        id: "reviewers",
        kind: "swarm",
        dependsOn: [],
        maxParallel: 2,
        join: { policy: "all", onFailure: "cancel_remaining" },
        steps: [leaf("left"), leaf("right")],
      },
    ],
  });
  yield* prepare(0);
  const uncertain = yield* prepare(1);
  yield* call((store) => store.beginDelivery(claim, uncertain.commandId));
  yield* failAttempt(0);
  NodeAssert.equal(claim.state, "running");
  NodeAssert.equal(claim.v4State?.nodes.find((node) => node.ordinal === 1)?.cancelRequested, true);
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 1);
  const premature = yield* call((store) =>
    store.record(claim, {
      commandId: uncertain.commandId,
      state: "failed",
      reason: "cancelled",
      receipt: null,
      result: null,
    }),
  ).pipe(Effect.result);
  NodeAssert.equal(premature._tag, "Failure");
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 1);
  NodeAssert.equal(
    yield* call((store) => store.confirmUndelivered(claim, uncertain.commandId)),
    true,
  );
  yield* refresh();
  NodeAssert.equal(claim.state, "failed");
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 0);
  yield* call((store) => store.release(claim));

  for (const kind of ["agent", "test"] as const) {
    yield* startVariant(`v4-${kind}-retry-budget`, {
      id: "review",
      limits: { maxConcurrentAgents: 1, maxAgentExecutions: 2 },
      steps: [
        kind === "agent"
          ? { ...leaf("retry"), retry: { maxAttempts: 2 } }
          : {
              id: "retry",
              kind: "test",
              dependsOn: [],
              checkId: "check",
              retry: { maxAttempts: 2 },
            },
        { ...leaf("next"), dependsOn: ["retry"] },
      ],
    });
    const failed = yield* prepare(0);
    yield* failAttempt(0);
    NodeAssert.equal(claim.state, "running");
    const repaired = yield* call((store) => store.repair(claim, failed.commandId));
    NodeAssert.ok(repaired);
    yield* refresh();
    NodeAssert.equal(claim.v4State?.startedAgentExecutions, 2);
    const old = claim.attempts.find((attempt) => attempt.commandId === failed.commandId)!;
    const late = yield* call((store) =>
      store.record(claim, {
        commandId: failed.commandId,
        state: "succeeded",
        reason: null,
        receipt: null,
        result: old.result,
      }),
    ).pipe(Effect.result);
    NodeAssert.equal(late._tag, "Failure");
    yield* call((store) =>
      store.record(claim, {
        commandId: repaired.commandId,
        state: "succeeded",
        reason: null,
        receipt: null,
        result: old.result,
      }),
    );
    yield* refresh();
    NodeAssert.equal(claim.state, "failed");
    NodeAssert.equal(claim.reason, "budget_exhausted");
    NodeAssert.equal(claim.v4State?.startedAgentExecutions, 2);
    NodeAssert.equal(claim.attempts.length, 2);
    yield* call((store) => store.release(claim));
  }
  yield* startVariant("v4-sandbox-deleted", {
    id: "review",
    limits: { maxConcurrentAgents: 1, maxAgentExecutions: 2 },
    steps: [leaf("work")],
  });
  const deletedAttempt = yield* prepare(0);
  yield* call((store) => store.beginDelivery(claim, deletedAttempt.commandId));
  NodeAssert.equal(
    yield* call((store) =>
      store.failTarget({ ...claim, generation: claim.generation - 1 }, "sandbox_deleted"),
    ),
    false,
  );
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 1);
  NodeAssert.equal(yield* call((store) => store.failTarget(claim, "sandbox_deleted")), true);
  yield* refresh();
  NodeAssert.equal(claim.state, "failed");
  NodeAssert.equal(claim.reason, "sandbox_deleted");
  NodeAssert.equal(claim.v4State?.status, "failed");
  NodeAssert.equal(claim.attempts[0]?.receipt, null);
  NodeAssert.equal((yield* call((store) => store.workerCapacity("v4-leaf")))?.occupied, 0);
  NodeAssert.equal(yield* call((store) => store.failTarget(claim, "sandbox_deleted")), false);
  yield* call((store) => store.release(claim));
});
