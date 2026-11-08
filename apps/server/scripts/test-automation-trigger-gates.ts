import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AutomationTriggerError,
  AuthSessionId,
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundryGatewayGrantId,
  FoundryGatewayError,
  FoundryWorkerExecution,
  ProjectId,
  ProviderInstanceId,
  type AutomationTriggerCommand,
  type AutomationTriggerBinding,
} from "@t3tools/contracts";
import { exportFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Definitions from "../src/automation/Definitions.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as Control from "../src/automation/Control.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as Publish from "../src/automation/Publish.ts";
import * as Triggers from "../src/automation/Triggers.ts";
import * as Unattended from "../src/automation/Unattended.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as GatewayGrants from "../src/foundry/GatewayGrants.ts";

const decodeExecution = Schema.decodeUnknownEffect(FoundryWorkerExecution);
const decodeGrant = Schema.decodeUnknownEffect(GatewayGrants.UnattendedGatewayIdentity);
export const triggerGates = Effect.fn("Triggers.postgresGates")(function <E>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
  restart: Effect.Effect<void, AutomationTriggerError>,
) {
  return Effect.gen(function* () {
    const identity = {
      instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
      operatorId: "fixture-trigger-owner",
      deviceId: FoundryDeviceId.make("66666666-6666-4666-8666-666666666666"),
      environmentId: EnvironmentId.make("trigger-worker"),
      deviceGeneration: 1,
      accessGeneration: 1,
      automationGeneration: 1,
      clientSessionId: AuthSessionId.make("trigger-client"),
      foundrySessionHash: "t".repeat(43),
    };
    const projectId = ProjectId.make("explicit-trigger-project");
    let operatorId = identity.operatorId;
    const deniedBindings = new Set<string>();
    const gateway = Layer.mock(GatewayGrants.GatewayGrants)({
      identityForWrite: (_request, scope) =>
        scope === "access:write"
          ? Effect.succeed({ ...identity, operatorId })
          : Effect.fail(new FoundryGatewayError({ code: "forbidden" })),
      identityForRead: () => Effect.succeed({ ...identity, operatorId }),
      create: () =>
        Effect.succeed({
          ...identity,
          grantId: FoundryGatewayGrantId.make("77777777-7777-4777-8777-777777777777"),
          protocolVersion: "2",
          grantKind: "clientAccess",
          scopes: ["orchestration:read"],
          origin: "https://fixture.test",
          subject: "fixture",
          generation: 1,
          channelGeneration: 1,
          expiresAt: 9e12,
        }),
      remove: () => Effect.void,
      projects: () =>
        Effect.succeed({
          projects: [
            {
              id: projectId,
              title: "Isolated trigger project",
              workspaceRoot: "/isolated/triggers",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              deletedAt: null,
            },
          ],
          updatedAt: "2026-01-01T00:00:00Z",
        }),
    });
    const worker = Layer.mock(WorkerTransport.WorkerTransport)({
      identityForRead: () => Effect.succeed({ ...identity, operatorId }),
      identityForWrite: () => Effect.succeed({ ...identity, operatorId }),
      authorize: () => Effect.succeed(identity),
      status: (value) =>
        GatewayGrants.isUnattendedIdentity(value) && deniedBindings.has(value.bindingId)
          ? Effect.fail(new WorkerTransport.WorkerTransportError({ reason: "forbidden" }))
          : Effect.succeed({
              online: true,
              projectReady: true,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerReady: true,
              providerState: "ready",
              roleExecutionVersion: 1,
              version: null,
              checkedAt: "2026-01-01T00:00:00Z",
              capacityAvailable: true,
              activeRuns: 0,
            }),
    });
    const workflows = Workflows.layer.pipe(Layer.provideMerge(Factories.layer));
    const dispatch = DispatchStore.layer.pipe(Layer.provideMerge(workflows));
    const services = Triggers.layer.pipe(
      Layer.provideMerge(dispatch),
      Layer.provideMerge(Unattended.layer),
      Layer.provide(gateway),
      Layer.provide(worker),
      Layer.provide(
        Layer.succeed(Triggers.TriggerConfig, {
          deviceId: identity.deviceId,
          environmentId: identity.environmentId,
          nextSchedule: Effect.fn("TriggerGate.nextSchedule")((_config, now) =>
            Effect.succeed(now + 86_400_000),
          ),
        }),
      ),
      Layer.provide(database),
      Layer.provide(NodeCrypto.layer),
    );
    const call = <A, E2>(f: (service: Triggers.Triggers["Service"]) => Effect.Effect<A, E2>) =>
      Triggers.Triggers.pipe(Effect.flatMap(f), Effect.provide(services));
    const query = <A, E2>(
      f: (sql: Database.AutomationDatabase["Service"]) => Effect.Effect<A, E2>,
    ) => Database.AutomationDatabase.pipe(Effect.flatMap(f), Effect.provide(database));
    const request = HttpServerRequest.fromWeb(
      new Request("https://fixture.test/triggers", { method: "POST" }),
    );
    const command = (input: AutomationTriggerCommand) =>
      call((service) => service.command(request, input));
    const definition = yield* Effect.gen(function* () {
      const factories = yield* Factories.Factories;
      const definitions = yield* Definitions.Definitions;
      yield* factories.createFactory({
        commandId: "trigger-factory-create",
        id: "trigger-factory",
        name: "Trigger gates",
      });
      yield* factories.createVersion({
        commandId: "trigger-scope-create",
        id: "trigger-scope",
        factoryId: "trigger-factory",
        repositories: ["trigger-repo"],
      });
      return yield* definitions.activate({
        commandId: "trigger-definition",
        factoryId: "trigger-factory",
        scopeVersionId: "trigger-scope",
        expectedVersionId: null,
        source: { kind: "foundry", reference: "trigger-gates" },
        files: exportFactoryFiles({
          schemaVersion: 1,
          factoryId: "trigger-factory",
          repositories: ["trigger-repo"],
          workflows: [
            {
              id: "flow",
              steps: [
                { id: "approval", kind: "approval", prompt: "Explicit acceptance", dependsOn: [] },
              ],
            },
          ],
        }),
      });
    }).pipe(
      Effect.provide(
        Definitions.layer.pipe(
          Layer.provideMerge(workflows),
          Layer.provide(database),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
    const create = (id: string, source: AutomationTriggerBinding["source"]) =>
      command({
        op: "create",
        commandId: `${id}:create`,
        id,
        factoryId: "trigger-factory",
        definitionVersionId: definition.id,
        workflowVersionId: definition.workflowVersions[0]!.versionId,
        repository: "trigger-repo",
        source,
        target: {
          deviceId: identity.deviceId,
          environmentId: identity.environmentId,
          projectId,
          model: "fixture",
          checks: [],
          requiredArtifacts: [],
        },
      });
    const github = {
      kind: "github_issue" as const,
      connectionId: "github-app",
      repositoryId: 123,
      repository: "fixture/repo",
      label: "foundry:run",
    };
    const created = yield* create("trigger-github", github);
    NodeAssert.equal(created.kind, "binding");
    NodeAssert.equal(created.kind === "binding" && created.binding.state, "inactive");
    NodeAssert.equal((yield* call((s) => s.duePolls(9e12, 50))).length, 0);
    const activate = {
      op: "activate" as const,
      commandId: "trigger-github:activate",
      bindingId: "trigger-github",
      generation: 1,
    };
    const active = yield* command(activate);
    NodeAssert.deepEqual(yield* command(activate), active);
    let polled = (yield* call((s) => s.duePolls(9e12, 50)))[0]!;
    const now = yield* Clock.currentTimeMillis;
    const oldIssue = {
      id: "event-old",
      externalId: "github-app:123:1",
      revision: "first",
      title: "Existing opted issue",
      occurredAt: now - 1000,
      payload: { body: "Old issue", reference: "https://github.com/fixture/repo/issues/1" },
    };
    const baseline = {
      bindingId: polled.binding.id,
      generation: 1,
      expectedCursor: polled.cursor,
      issues: [oldIssue],
      nextCursor: { since: now - 60000, page: 1, windowEnd: now },
      complete: true,
    };
    NodeAssert.equal(yield* call((s) => s.acceptIssueBatch(baseline)), true);
    NodeAssert.equal(yield* call((s) => s.acceptIssueBatch(baseline)), false);
    NodeAssert.equal(yield* call((s) => s.admit(oldIssue.id)), false);
    polled = (yield* call((s) => s.duePolls(9e12, 50)))[0]!;
    const issue = {
      ...oldIssue,
      id: "event-new",
      externalId: "github-app:123:2",
      title: "New opted issue",
    };
    const batch = {
      ...baseline,
      expectedCursor: polled.cursor,
      issues: [issue],
      nextCursor: { ...polled.cursor, windowEnd: now + 1 },
    };
    const accepted = yield* Effect.all(
      Array.from({ length: 8 }, () => call((s) => s.acceptIssueBatch(batch))),
      { concurrency: "unbounded" },
    );
    NodeAssert.equal(accepted.filter(Boolean).length, 1);
    const rollbackBatch = {
      ...batch,
      expectedCursor: batch.nextCursor,
      nextCursor: { ...batch.nextCursor, windowEnd: now + 99 },
      issues: [
        { ...issue, id: "rollback-first", externalId: "rollback-first" },
        { ...issue, id: oldIssue.id, externalId: "collision" },
      ],
    };
    NodeAssert.equal(
      (yield* call((service) => service.acceptIssueBatch(rollbackBatch)).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal(
      (yield* query(
        (sql) => sql`SELECT id FROM foundry_automation.trigger_events WHERE id='rollback-first'`,
      )).length,
      0,
    );
    NodeAssert.deepEqual(
      (yield* call((service) => service.duePolls(9e12, 50)))[0]?.cursor,
      batch.nextCursor,
    );
    yield* restart;
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => call((s) => s.admit(issue.id))),
      { concurrency: "unbounded" },
    );
    NodeAssert.equal(claims.filter(Boolean).length, 1);
    const admissions = yield* query(
      (sql) =>
        sql<{
          runId: string;
        }>`SELECT run_id AS "runId" FROM foundry_automation.trigger_admissions WHERE event_id=${issue.id}`,
    );
    NodeAssert.equal(admissions.length, 1);
    const replay = {
      ...batch,
      expectedCursor: batch.nextCursor,
      nextCursor: { ...batch.nextCursor, windowEnd: now + 2 },
      issues: [{ ...issue, revision: "second revision" }],
    };
    NodeAssert.equal(yield* call((s) => s.acceptIssueBatch(replay)), true);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql`SELECT id FROM foundry_automation.trigger_events WHERE external_id=${issue.externalId}`,
      )).length,
      1,
    );
    NodeAssert.equal(yield* call((s) => s.admit(issue.id)), false);
    operatorId = "other-owner";
    NodeAssert.equal(
      (yield* call((s) =>
        s.query(request, { op: "events", bindingId: "trigger-github", limit: 50 }),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
    operatorId = identity.operatorId;
    const pending = { ...issue, id: "event-retained", externalId: "github-app:123:3" };
    yield* call((s) =>
      s.acceptIssueBatch({
        ...batch,
        expectedCursor: replay.nextCursor,
        nextCursor: { ...replay.nextCursor, windowEnd: now + 3 },
        issues: [pending],
      }),
    );
    yield* command({
      op: "deactivate",
      commandId: "pause-retain",
      bindingId: "trigger-github",
      generation: 1,
      pending: "retain",
    });
    NodeAssert.equal(yield* call((s) => s.admit(pending.id)), false);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            state: string;
          }>`SELECT state FROM foundry_automation.trigger_events WHERE id=${pending.id}`,
      ))[0]?.state,
      "accepted",
    );
    yield* command({ ...activate, commandId: "reactivate" });
    polled = (yield* call((s) => s.duePolls(9e12, 50)))[0]!;
    yield* call((s) =>
      s.acceptIssueBatch({
        ...baseline,
        expectedCursor: polled.cursor,
        issues: [],
        nextCursor: { since: now, page: 1, windowEnd: now + 4 },
      }),
    );
    NodeAssert.equal(yield* call((s) => s.admit(pending.id)), true);
    yield* create("trigger-second", github);
    yield* command({ ...activate, commandId: "second-activate", bindingId: "trigger-second" });
    const second = (yield* call((s) => s.duePolls(9e12, 50))).find(
      (b) => b.binding.id === "trigger-second",
    )!;
    yield* call((s) =>
      s.acceptIssueBatch({
        ...baseline,
        bindingId: "trigger-second",
        expectedCursor: second.cursor,
        issues: [],
        nextCursor: { since: now, page: 1, windowEnd: now },
      }),
    );
    yield* call((s) =>
      s.acceptIssueBatch({
        ...batch,
        bindingId: "trigger-second",
        expectedCursor: { since: now, page: 1, windowEnd: now },
        issues: [{ ...issue, id: "event-second-binding" }],
      }),
    );
    NodeAssert.equal(yield* call((s) => s.admit("event-second-binding")), true);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql`SELECT id FROM foundry_automation.trigger_events WHERE external_id=${issue.externalId}`,
      )).length,
      2,
    );
    const schedule = {
      kind: "schedule" as const,
      config: {
        timeZone: "Europe/Berlin",
        timeOfDay: "09:00",
        weekdays: [1, 2, 3, 4, 5],
        catchUp: "bounded" as const,
        maxCatchUp: 2,
        overlap: "wait" as const,
      },
    };
    yield* create("trigger-schedule", schedule);
    yield* command({ ...activate, commandId: "schedule-activate", bindingId: "trigger-schedule" });
    const initialSchedule = (yield* call((s) => s.query(request, { op: "bindings", limit: 50 })))
      .kind;
    NodeAssert.equal(initialSchedule, "bindings");
    const dueAt = 1_000_000_000_000;
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.trigger_bindings SET next_due_at=${dueAt} WHERE id='trigger-schedule'`,
    );
    const scheduled = {
      bindingId: "trigger-schedule",
      generation: 1,
      expectedNextDueAt: dueAt,
      occurrences: [{ id: "schedule-first", dueAt }],
      nextDueAt: now + 86_400_000,
      skipped: 1,
    };
    const scheduledClaims = yield* Effect.all(
      Array.from({ length: 8 }, () => call((s) => s.acceptScheduledBatch(scheduled))),
      { concurrency: "unbounded" },
    );
    NodeAssert.equal(scheduledClaims.filter(Boolean).length, 1);
    NodeAssert.equal(yield* call((s) => s.admit("schedule-first")), true);
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.trigger_bindings SET next_due_at=${dueAt + 1} WHERE id='trigger-schedule'`,
    );
    NodeAssert.equal(
      (yield* call((s) =>
        s.acceptScheduledBatch({
          ...scheduled,
          expectedNextDueAt: dueAt + 1,
          occurrences: [{ id: issue.id, dueAt: dueAt + 1 }],
        }),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal(
      Number(
        (yield* query(
          (sql) =>
            sql<{
              next: number;
            }>`SELECT next_due_at::float8 AS next FROM foundry_automation.trigger_bindings WHERE id='trigger-schedule'`,
        ))[0]?.next,
      ),
      dueAt + 1,
    );
    yield* call((s) =>
      s.acceptScheduledBatch({
        ...scheduled,
        expectedNextDueAt: dueAt + 1,
        occurrences: [{ id: "schedule-overlap", dueAt: dueAt + 1 }],
      }),
    );
    NodeAssert.equal(yield* call((s) => s.admit("schedule-overlap")), false);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            state: string;
          }>`SELECT state FROM foundry_automation.trigger_events WHERE id='schedule-overlap'`,
      ))[0]?.state,
      "accepted",
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.trigger_bindings SET source=jsonb_set(source,'{config,overlap}','"skip"'::jsonb) WHERE id='trigger-schedule'`,
    );
    NodeAssert.equal(yield* call((s) => s.admit("schedule-overlap")), false);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            state: string;
          }>`SELECT state FROM foundry_automation.trigger_events WHERE id='schedule-overlap'`,
      ))[0]?.state,
      "skipped",
    );
    yield* command({
      op: "deactivate",
      commandId: "schedule-disable",
      bindingId: "trigger-schedule",
      generation: 1,
      pending: "discard",
    });
    NodeAssert.equal(
      yield* call((s) =>
        s.acceptScheduledBatch({
          ...scheduled,
          expectedNextDueAt: scheduled.nextDueAt,
          nextDueAt: scheduled.nextDueAt + 1,
          occurrences: [],
        }),
      ),
      false,
    );
    const grantRows = yield* query(
      (sql) =>
        sql<{
          identity: unknown;
        }>`SELECT identity FROM foundry_automation.unattended_grants WHERE binding_id='trigger-second'`,
    );
    const grant = yield* decodeGrant(grantRows[0]!.identity);
    const secondAdmission = yield* query(
      (sql) =>
        sql<{
          runId: string;
        }>`SELECT run_id AS "runId" FROM foundry_automation.trigger_admissions WHERE event_id='event-second-binding'`,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request) VALUES('grant-owned-command',${secondAdmission[0]!.runId},0,'{}'::jsonb)`,
    );
    const checkScope = (operation: {
      commandId: string;
      projectId?: string;
      previousCommandId?: string;
    }) =>
      Unattended.Unattended.pipe(
        Effect.flatMap((service) => service.validate(grant, operation)),
        Effect.provide(Unattended.layer.pipe(Layer.provide(database))),
      );
    yield* checkScope({ commandId: "grant-owned-command", projectId });
    NodeAssert.equal(
      (yield* checkScope({ commandId: "grant-owned-command", projectId: "foreign-project" }).pipe(
        Effect.result,
      ))._tag,
      "Failure",
    );
    NodeAssert.equal(
      (yield* checkScope({ commandId: "foreign-command", projectId }).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal(
      (yield* checkScope({
        commandId: "grant-owned-command",
        projectId,
        previousCommandId: "foreign-command",
      }).pipe(Effect.result))._tag,
      "Failure",
    );
    const publishCall = <A, E2>(
      operation: (service: Publish.PublishOperations["Service"]) => Effect.Effect<A, E2>,
    ) =>
      Publish.PublishOperations.pipe(
        Effect.flatMap(operation),
        Effect.provide(Publish.operationsLayer.pipe(Layer.provide(database))),
      );
    const operation = {
      operationKey: "publish-gate",
      runId: secondAdmission[0]!.runId,
      stepId: "publish",
      commitSha: "a".repeat(40),
      resultRevision: 1,
      repository: "fixture/repo",
      request: { revision: 1 },
    };
    const began = yield* Effect.all(
      Array.from({ length: 4 }, () => publishCall((service) => service.begin(operation))),
      { concurrency: "unbounded" },
    );
    NodeAssert.deepEqual(began, [null, null, null, null]);
    NodeAssert.equal(
      (yield* publishCall((service) =>
        service.begin({ ...operation, request: { revision: 2 } }),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal(
      (yield* publishCall((service) =>
        service.begin({ ...operation, operationKey: "different-key" }),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
    const published = {
      number: 17,
      url: "https://github.com/fixture/repo/pull/17",
      commitSha: operation.commitSha,
      operationKey: operation.operationKey,
    };
    NodeAssert.equal(
      (yield* publishCall((service) =>
        service.finish(operation.operationKey, { revision: 2 }, published),
      ).pipe(Effect.result))._tag,
      "Failure",
    );
    NodeAssert.equal(yield* publishCall((service) => service.begin(operation)), null);
    yield* publishCall((service) =>
      service.finish(operation.operationKey, operation.request, published),
    );
    NodeAssert.deepEqual(yield* publishCall((service) => service.begin(operation)), published);
    yield* Console.log(
      "PASS P23 PostgreSQL: concurrent operation keys, conflicting requests and duplicate run/step/result prevention, failed finish rollback, durable result after service recreation.",
    );
    const validate = Unattended.Unattended.pipe(
      Effect.flatMap((s) => s.validate(grant)),
      Effect.provide(Unattended.layer.pipe(Layer.provide(database))),
    );
    yield* validate;
    yield* command({
      op: "revoke",
      commandId: "revoke-second",
      bindingId: "trigger-second",
      generation: 1,
    });
    NodeAssert.equal((yield* validate.pipe(Effect.result))._tag, "Failure");
    NodeAssert.equal(
      (yield* call((s) => s.duePolls(9e12, 50))).some((b) => b.binding.id === "trigger-second"),
      false,
    );
    const cancelRunId = secondAdmission[0]!.runId;
    const storeCall = <A, E2>(
      operation: (service: DispatchStore.DispatchStore["Service"]) => Effect.Effect<A, E2>,
    ) =>
      DispatchStore.DispatchStore.pipe(
        Effect.flatMap(operation),
        Effect.provide(dispatch.pipe(Layer.provide(database))),
      );
    const controlCall = <A, E2>(
      operation: (service: Control.Control["Service"]) => Effect.Effect<A, E2>,
    ) =>
      Control.Control.pipe(
        Effect.flatMap(operation),
        Effect.provide(
          Control.layer.pipe(
            Layer.provide(dispatch),
            Layer.provide(worker),
            Layer.provide(
              Layer.succeed(Scheduler.SchedulerConfig, {
                deviceId: identity.deviceId,
                environmentId: identity.environmentId,
                allowedRunIds: [],
              }),
            ),
            Layer.provide(database),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      );
    NodeAssert.equal(yield* storeCall((service) => service.permitted(cancelRunId)), false);
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.step_attempts SET state='running' WHERE command_id='grant-owned-command'`,
    );
    const beforeCancel = yield* controlCall((service) =>
      service.read(request, "trigger-factory", cancelRunId),
    );
    yield* controlCall((service) =>
      service.execute(request, {
        commandId: "revoked-trigger-cancel",
        factoryId: "trigger-factory",
        runId: cancelRunId,
        expectedRevision: beforeCancel.revision,
        action: "cancel",
      }),
    );
    NodeAssert.equal(yield* storeCall((service) => service.permitted(cancelRunId)), true);
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.dispatch_workers SET run_id=${cancelRunId},lease_until='-infinity',claim_owner=NULL WHERE worker_id=${identity.deviceId}`,
    );
    const cancelClaim = yield* storeCall((service) =>
      service.claimNext({
        workerId: identity.deviceId,
        owner: "revoked-trigger-cancel-owner",
        leaseMillis: 60000,
      }),
    );
    NodeAssert.ok(cancelClaim);
    NodeAssert.equal(yield* storeCall((service) => service.canLaunch(cancelClaim)), false);
    NodeAssert.equal(
      yield* storeCall((service) => service.completeApproval(cancelClaim, 0, "must-not-complete")),
      false,
    );
    NodeAssert.equal(yield* storeCall((service) => service.confirmCancel(cancelClaim)), false);
    const execution = yield* decodeExecution({
      receipt: {
        commandId: "grant-owned-command",
        threadId: "cancel-trigger-thread",
        acceptedAt: "2026-01-01T00:00:00Z",
        sequence: 1,
      },
      run: { id: "cancel-trigger-native-run", status: "cancelled", checkpointId: null },
      lifecycle: {
        generation: 1,
        expiresAt: now + 60000,
        state: "stopped",
        writerEnded: true,
        manifest: {
          generation: 1,
          runId: "cancel-trigger-native-run",
          checkpointId: null,
          checkpointRef: null,
          outcome: "stopped",
        },
      },
    });
    yield* storeCall((service) =>
      service.record(cancelClaim, {
        commandId: "grant-owned-command",
        state: "running",
        reason: "writer_end_pending",
        receipt: null,
        result: {
          execution: {
            ...execution,
            lifecycle: { ...execution.lifecycle!, writerEnded: false, manifest: null },
          },
        },
      }),
    );
    NodeAssert.equal(yield* storeCall((service) => service.confirmCancel(cancelClaim)), false);
    yield* storeCall((service) =>
      service.record(cancelClaim, {
        commandId: "grant-owned-command",
        state: "failed",
        reason: "cancelled",
        receipt: null,
        result: { execution },
      }),
    );
    NodeAssert.equal(yield* storeCall((service) => service.confirmCancel(cancelClaim)), true);
    NodeAssert.equal(yield* storeCall((service) => service.permitted(cancelRunId)), false);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            runId: string | null;
          }>`SELECT run_id AS "runId" FROM foundry_automation.dispatch_workers WHERE worker_id=${identity.deviceId}`,
      ))[0]?.runId,
      null,
    );
    NodeAssert.equal(
      (yield* controlCall((service) => service.read(request, "trigger-factory", cancelRunId)))
        .state,
      "cancelled",
    );
    yield* Console.log(
      "PASS revoked trigger cancellation: fresh manual Control.cancel authorizes recovery only, launches/approvals stay fenced, cancellation and slot release require positive writer-end evidence.",
    );
    yield* create("fair-blocked", github);
    yield* command({ ...activate, commandId: "fair-activate", bindingId: "fair-blocked" });
    const fair = (yield* call((service) => service.duePolls(9e12, 50))).find(
      (item) => item.binding.id === "fair-blocked",
    )!;
    const fairCursor = { since: now, page: 1, windowEnd: now };
    yield* call((service) =>
      service.acceptIssueBatch({
        ...baseline,
        bindingId: "fair-blocked",
        expectedCursor: fair.cursor,
        nextCursor: fairCursor,
        issues: [],
      }),
    );
    yield* call((service) =>
      service.acceptIssueBatch({
        ...batch,
        bindingId: "fair-blocked",
        expectedCursor: fairCursor,
        issues: Array.from({ length: 50 }, (_, i) => ({
          ...issue,
          id: `fair-blocked-${i}`,
          externalId: `fair-${i}`,
        })),
      }),
    );
    const goodCursor = (yield* call((service) => service.duePolls(9e12, 50))).find(
      (item) => item.binding.id === "trigger-github",
    )!.cursor;
    yield* call((service) =>
      service.acceptIssueBatch({
        ...batch,
        expectedCursor: goodCursor,
        issues: [{ ...issue, id: "fair-allowed", externalId: "fair-allowed" }],
      }),
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.trigger_events SET received_at=1 WHERE binding_id='fair-blocked'`,
    );
    yield* query(
      (sql) =>
        sql`UPDATE foundry_automation.trigger_events SET received_at=2 WHERE id='fair-allowed'`,
    );
    deniedBindings.add("fair-blocked");
    NodeAssert.equal(yield* call((service) => service.tick), 0);
    NodeAssert.equal(yield* call((service) => service.tick), 1);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            state: string;
          }>`SELECT state FROM foundry_automation.trigger_events WHERE id='fair-allowed'`,
      ))[0]?.state,
      "admitted",
    );
    yield* Console.log(
      "PASS P24 fairness: fifty blocked inputs cannot starve a later authorized binding.",
    );
    const replacement = yield* Definitions.Definitions.pipe(
      Effect.flatMap((definitions) =>
        definitions.activate({
          commandId: "trigger-replacement",
          factoryId: "trigger-factory",
          scopeVersionId: "trigger-scope",
          expectedVersionId: definition.id,
          source: { kind: "foundry", reference: "replacement" },
          files: exportFactoryFiles({
            schemaVersion: 1,
            factoryId: "trigger-factory",
            repositories: ["trigger-repo"],
            workflows: [
              {
                id: "flow",
                steps: [
                  { id: "new-approval", kind: "approval", prompt: "New version", dependsOn: [] },
                ],
              },
            ],
          }),
        }),
      ),
      Effect.provide(
        Definitions.layer.pipe(
          Layer.provideMerge(workflows),
          Layer.provide(database),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
    NodeAssert.notEqual(replacement.id, definition.id);
    const pinnedCursor = (yield* call((service) => service.duePolls(9e12, 50))).find(
      (item) => item.binding.id === "trigger-github",
    )!.cursor;
    yield* call((service) =>
      service.acceptIssueBatch({
        ...batch,
        expectedCursor: pinnedCursor,
        issues: [{ ...issue, id: "pinned-old-version", externalId: "pinned-old-version" }],
      }),
    );
    NodeAssert.equal(yield* call((service) => service.admit("pinned-old-version")), true);
    NodeAssert.equal(
      (yield* query(
        (sql) =>
          sql<{
            version: string;
          }>`SELECT r.workflow_version_id AS version FROM foundry_automation.runs r JOIN foundry_automation.trigger_events e ON e.run_id=r.id WHERE e.id='pinned-old-version'`,
      ))[0]?.version,
      definition.workflowVersions[0]!.versionId,
    );
    yield* query(
      (sql) =>
        sql`INSERT INTO foundry_automation.definition_sources(factory_id,location,scope_version_id,instance_id,operator_id,app_generation,ownership) VALUES('trigger-factory','{}'::jsonb,${definition.scopeVersionId},${identity.instanceId},${identity.operatorId},1,'git')`,
    );
    NodeAssert.equal(
      (yield* create("git-competing-create", github).pipe(Effect.flip)).code,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* command({ ...activate, commandId: "git-legacy-reactivation" }).pipe(Effect.flip))
        .code,
      "forbidden",
    );
    yield* Console.log(
      "PASS P22/P24 PostgreSQL: inactive activation/baseline, cursor CAS and rollback, concurrent acceptance/admission, PostgreSQL restart after durable acceptance, binding-separated deduplication, pinned definitions, owner isolation, retain/reactivate, schedule CAS and overlap wait/skip, delegation revocation.",
    );
  });
});
