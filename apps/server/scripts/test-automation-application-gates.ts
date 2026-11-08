import * as Evaluations from "../src/automation/Evaluations.ts";
import * as EvaluationJudge from "../src/automation/EvaluationJudge.ts";
import * as ThreadArchive from "../src/foundry/ThreadArchive.ts";
import * as McpBindings from "../src/automation/McpBindings.ts";
import * as DispatchStore from "../src/automation/DispatchStore.ts";
import * as MachineAccess from "../src/automation/MachineAccess.ts";
import * as MachineCredentials from "../src/foundry/MachineCredentials.ts";
import * as Handoffs from "../src/automation/Handoffs.ts";
import * as DefinitionSources from "../src/automation/DefinitionSources.ts";
import * as GitHubApp from "../src/automation/GitHubApp.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Assertions run inside the isolated PostgreSQL harness.
import * as NodeAssert from "node:assert/strict";
import {
  ProjectId,
  AutomationApplicationError,
  AutomationMachineCredentialError,
  FoundryGatewayError,
  FoundryInstanceId,
  EnvironmentId,
  FoundryDeviceId,
  AutomationControlError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { exportFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Application from "../src/automation/Application.ts";
import * as ApiHttp from "../src/automation/ApiHttp.ts";
import * as Http from "../src/automation/Http.ts";
import * as Inbox from "../src/automation/Inbox.ts";
import * as Triggers from "../src/automation/Triggers.ts";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Definitions from "../src/automation/Definitions.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as Control from "../src/automation/Control.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as GatewayGrants from "../src/foundry/GatewayGrants.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const applicationGates = Effect.fn("Application.postgresGates")(function <E>(
  database: Layer.Layer<Database.AutomationDatabase, E>,
) {
  const unused = Effect.fn("ApplicationGate.unused")(() =>
    Effect.die("Unexpected network operation during central read-model gate"),
  );
  const identity = {
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    operatorId: "fixture-operator",
  };
  const worker = WorkerTransport.WorkerTransport.of({
    evaluate: Effect.fn("Fixture.evaluate")(() => Effect.die("unused")),
    sandboxProjects: Effect.fn("Fixture.sandboxProjects")(() => Effect.die("unused")),
    sandboxStatus: Effect.fn("Fixture.sandboxStatus")(() => Effect.die("unused")),
    retargetSandbox: Effect.fn("Fixture.retargetSandbox")(() => Effect.die("unused")),
    handoffOpen: Effect.fn("Fixture.handoffOpen")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    handoffFinish: Effect.fn("Fixture.handoffFinish")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    handoffReopen: Effect.fn("Fixture.handoffReopen")(() =>
      Effect.die("Handoff not configured in this fixture"),
    ),
    identityForRead: Effect.fn("ApplicationGate.readIdentity")(() => Effect.succeed(identity)),
    identityForWrite: Effect.fn("ApplicationGate.writeIdentity")(() => Effect.succeed(identity)),
    authorize: unused,
    status: unused,
    launch: unused,
    read: unused,
    renew: unused,
    cancel: unused,
    answer: unused,
  });
  const gateway = Layer.succeed(
    GatewayGrants.GatewayGrants,
    GatewayGrants.GatewayGrants.of({
      sandboxProjects: Effect.fn("Fixture.sandboxProjects")(() => Effect.die("unused")),
      sandboxProbe: Effect.fn("Fixture.sandboxProbe")(() => Effect.die("unused")),
      retargetSandbox: Effect.fn("Fixture.retargetSandbox")(() => Effect.die("unused")),
      identityForRead: Effect.fn("ApplicationGate.gatewayIdentity")(function* (request) {
        if (request.headers.authorization)
          return yield* new FoundryGatewayError({ code: "forbidden" });
        return identity;
      }),
      identityForWrite: Effect.fn("ApplicationGate.authorize")(function* (request, scope) {
        if (request.headers.authorization || request.headers["x-fixture-scope"] !== scope)
          return yield* new FoundryGatewayError({ code: "forbidden" });
        return identity;
      }),
      catalog: unused,
      approveDevice: unused,
      revokeDevice: unused,
      readAccess: unused,
      updateAccess: unused,
      create: unused,
      ticket: unused,
      stream: unused,
      projects: unused,
      inspect: unused,
      remove: unused,
      authorizeAutomation: unused,
      openAutomation: unused,
    }),
  );
  const machineAccess = MachineAccess.layer.pipe(
    Layer.provide(
      Layer.mock(MachineCredentials.MachineCredentials)({
        authenticate: Effect.fn("ApplicationGate.machineIdentity")(function* (token) {
          if (token !== "fmc_fixture_a" && token !== "fmc_fixture_b" && token !== "fmc_start_a")
            return yield* new AutomationMachineCredentialError({ code: "forbidden" });
          return {
            ...identity,
            credentialId: token,
            scope:
              token === "fmc_start_a"
                ? ("automation:start" as const)
                : ("automation:read" as const),
            factoryIds: [token !== "fmc_fixture_b" ? "p21-a" : "p21-b"],
          };
        }),
      }),
    ),
    Layer.provide(Factories.layer),
    Layer.provide(gateway),
    Layer.provide(database),
  );
  const layer = Application.layer.pipe(
    Layer.provide(
      Evaluations.layer.pipe(
        Layer.provide(Layer.succeed(EvaluationJudge.EvaluationJudge, { judge: unused })),
        Layer.provide(Layer.mock(ThreadArchive.ThreadArchive)({ read: unused })),
      ),
    ),
    Layer.provide(Layer.mock(ThreadArchive.ThreadArchive)({ read: unused })),

    Layer.provide(McpBindings.layer),
    Layer.provide(DispatchStore.layer),
    Layer.provide(machineAccess),
    Layer.provide(Layer.mock(Handoffs.Handoffs)({ query: unused, execute: unused })),
    Layer.provide(DefinitionSources.layer),
    Layer.provide(Layer.mock(GitHubApp.GitHubApp)({ binding: unused })),
    Layer.provide(
      Definitions.layer.pipe(
        Layer.provideMerge(Workflows.layer.pipe(Layer.provideMerge(Factories.layer))),
      ),
    ),
    Layer.provide(Layer.succeed(WorkerTransport.WorkerTransport, worker)),
    Layer.provide(gateway),
    Layer.provide(
      Layer.succeed(Control.Control, {
        read: Effect.fn("ApplicationGate.noControl")(() =>
          Effect.fail(new AutomationControlError({ code: "not_found" })),
        ),
        readAuthorized: Effect.fn("ApplicationGate.controlSnapshot")((_, factoryId, runId) =>
          Effect.succeed({
            factoryId,
            runId,
            revision: 0,
            resultRevision: 0,
            state: "running" as const,
            reason: null,
          }),
        ),
        execute: unused,
      }),
    ),
    Layer.provide(
      Layer.succeed(Scheduler.Scheduler, {
        start: unused,
        enroll: unused,
        read: unused,
        tick: Effect.succeed(false),
      }),
    ),
    Layer.provide(
      Layer.succeed(Scheduler.SchedulerConfig, {
        deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
        environmentId: EnvironmentId.make("fixture-worker"),
        allowedRunIds: [],
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(database),
  );
  return Effect.gen(function* () {
    const app = yield* Application.Application;
    const sql = yield* Database.AutomationDatabase;
    const request = HttpServerRequest.fromWeb(
      new Request("http://fixture.invalid", { headers: { "x-fixture-scope": "access:write" } }),
    );
    const operate = HttpServerRequest.fromWeb(
      new Request("http://fixture.invalid", {
        headers: { "x-fixture-scope": "orchestration:operate" },
      }),
    );
    const create = {
      op: "createFactory" as const,
      commandId: "p21-create",
      id: "p21-a",
      name: "P21 alpha",
      scopeVersionId: "p21-scope",
      repositories: ["fixture-repo"],
    };
    const first = yield* app.command(request, create);
    NodeAssert.equal(first.kind, "factory");
    const httpLayers = Layer.mergeAll(Http.layer, ApiHttp.layer).pipe(
      Layer.provide(Layer.succeed(Application.Application, app)),
      Layer.provide(Layer.mock(Control.Control)({ execute: unused })),
      Layer.provide(Layer.mock(Inbox.Inbox)({ query: unused, mark: unused })),
      Layer.provide(Layer.mock(Triggers.Triggers)({ query: unused, command: unused })),
      Layer.provide(gateway),
      Layer.provide(machineAccess),
    );
    const http = HttpRouter.toWebHandler(httpLayers, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => http.dispose()));
    const send = (path: string, input: unknown, scope = "access:write", authorization?: string) =>
      Effect.promise(() =>
        http.handler(
          new Request(`http://fixture.invalid${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-fixture-scope": scope,
              ...(authorization ? { authorization } : {}),
            },
            body: encodeJson(input),
          }),
        ),
      );
    const retried = yield* send("/api/foundry/v1/automation/command", create);
    NodeAssert.equal(retried.status, 200);
    NodeAssert.deepEqual(yield* Effect.promise(() => retried.json()), first);
    const conflict = yield* send("/api/foundry/v1/automation/command", {
      ...create,
      repositories: ["changed"],
    });
    NodeAssert.equal(conflict.status, 409);
    const denied = yield* send(
      "/api/foundry/v1/automation/command",
      { ...create, commandId: "p58-denied", id: "p58-denied" },
      "orchestration:read",
    );
    NodeAssert.equal(denied.status, 403);
    NodeAssert.equal(
      (yield* sql`SELECT id FROM foundry_automation.factories WHERE id='p58-denied'`).length,
      0,
    );
    const queryInput = { op: "factory", factoryId: create.id };
    const uiResponse = yield* send("/api/foundry/automation/query", queryInput);
    const apiResponse = yield* send("/api/foundry/v1/automation/query", queryInput);
    NodeAssert.deepEqual(
      yield* Effect.promise(() => apiResponse.json()),
      yield* Effect.promise(() => uiResponse.json()),
    );
    yield* app.command(request, create);
    NodeAssert.equal(
      (yield* app
        .command(operate, { ...create, commandId: "p21-denied", id: "p21-forbidden" })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* app.command(request, { ...create, repositories: ["changed"] }).pipe(Effect.flip))
        .code,
      "conflict",
    );
    yield* app.command(request, {
      ...create,
      commandId: "p21-create-b",
      id: "p21-b",
      name: "P21 beta",
      scopeVersionId: "p21-scope-b",
    });
    const machineRequest = (token: string, path = "/api/foundry/v1/automation/query") =>
      HttpServerRequest.fromWeb(
        new Request(`http://fixture.invalid${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-fixture-scope": "access:write" },
        }),
      );
    const machineStart = machineRequest("fmc_start_a", "/api/foundry/v1/automation/command");
    const machineWork = {
      op: "createWorkItem" as const,
      input: {
        commandId: "n06-work",
        id: "n06-work",
        factoryId: "p21-a",
        versionId: "p21-scope",
        repository: "fixture-repo",
        title: "Machine work",
        source: { kind: "manual" as const, reference: "ci-42" },
      },
    };
    const machineA = machineRequest("fmc_fixture_a");
    const machineB = machineRequest("fmc_fixture_b");
    const machinePage = yield* app.query(machineB, { op: "factories", search: "P21", limit: 1 });
    NodeAssert.equal(machinePage.kind, "factories");
    if (machinePage.kind === "factories") {
      NodeAssert.deepEqual(
        machinePage.items.map((item) => item.id),
        ["p21-b"],
      );
      NodeAssert.equal(machinePage.next, null);
    }
    const afterMachinePage = yield* app.query(machineB, {
      op: "factories",
      limit: 1,
      after: "p21-b",
    });
    if (afterMachinePage.kind === "factories") NodeAssert.deepEqual(afterMachinePage.items, []);
    for (const input of [
      { op: "factory" as const, factoryId: "p21-a" },
      { op: "workItems" as const, factoryId: "p21-a", limit: 1 },
      { op: "runs" as const, factoryId: "p21-a", limit: 1 },
      { op: "workerBinding" as const },
      { op: "executionDefaults" as const, factoryId: "p21-b", repository: "fixture-repo" },
      { op: "definitionSource" as const, factoryId: "p21-b" },
      { op: "handoffs" as const, factoryId: "p21-b", workItemId: "p21-work" },
    ])
      NodeAssert.equal((yield* app.query(machineB, input).pipe(Effect.flip)).code, "forbidden");
    for (const credential of ["fmc_invalid", "ordinary-mcp-token"]) {
      const response = yield* send(
        "/api/foundry/v1/automation/query",
        { op: "factories", limit: 1 },
        "access:write",
        `Bearer ${credential}`,
      );
      NodeAssert.equal(response.status, 403);
    }
    NodeAssert.equal(
      (yield* app
        .query(machineRequest("fmc_fixture_b", "/api/foundry/automation/query"), {
          op: "factories",
          limit: 1,
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    const machineContract = yield* send(
      "/api/foundry/v1/automation/contract",
      {},
      "access:write",
      "Bearer fmc_fixture_b",
    );
    NodeAssert.equal(machineContract.status, 200);
    const machineWrite = yield* send(
      "/api/foundry/v1/automation/command",
      { ...create, commandId: "p58-machine-denied", id: "p58-machine-denied" },
      "access:write",
      "Bearer fmc_fixture_b",
    );
    NodeAssert.equal(machineWrite.status, 403);
    NodeAssert.equal(
      (yield* sql`SELECT id FROM foundry_automation.factories WHERE id='p58-machine-denied'`)
        .length,
      0,
    );
    const machineManagement = yield* send(
      "/api/foundry/v1/automation/credentials/list",
      {},
      "access:write",
      "Bearer fmc_fixture_b",
    );
    NodeAssert.equal(machineManagement.status, 403);
    const page = yield* app.query(operate, { op: "factories", search: "P21", limit: 1 });
    NodeAssert.equal(page.kind, "factories");
    if (page.kind !== "factories")
      return yield* new AutomationApplicationError({ code: "unavailable" });
    NodeAssert.deepEqual(
      page.items.map((item) => item.id),
      ["p21-a"],
    );
    NodeAssert.equal(page.next, "p21-a");
    const next = yield* app.query(operate, {
      op: "factories",
      search: "P21",
      limit: 1,
      after: page.next!,
    });
    NodeAssert.equal(next.kind, "factories");
    if (next.kind === "factories") {
      NodeAssert.deepEqual(
        next.items.map((item) => item.id),
        ["p21-b"],
      );
      NodeAssert.equal(next.next, null);
    }
    const active = yield* app.command(request, {
      op: "activateDefinition",
      input: {
        commandId: "p21-activate",
        factoryId: "p21-a",
        scopeVersionId: "p21-scope",
        expectedVersionId: null,
        source: { kind: "foundry", reference: "isolated-gate" },
        files: exportFactoryFiles({
          schemaVersion: 1,
          factoryId: "p21-a",
          repositories: ["fixture-repo"],
          workflows: [
            {
              id: "main",
              steps: [{ id: "review", kind: "approval", dependsOn: [], prompt: "Review fixture" }],
            },
          ],
        }),
      },
    });
    NodeAssert.equal(active.kind, "definition");
    if (active.kind !== "definition")
      return yield* new AutomationApplicationError({ code: "unavailable" });
    const defaultsCommand = {
      op: "configureExecutionDefaults" as const,
      commandId: "p28-defaults",
      factoryId: "p21-a",
      repository: "fixture-repo",
      expectedGeneration: null,
      projectId: ProjectId.make("worker-project"),
      model: "fallback-model",
      checks: [],
      requiredArtifacts: [],
    };
    NodeAssert.equal(
      (yield* app.command(operate, defaultsCommand).pipe(Effect.flip)).code,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* app.command(machineA, defaultsCommand).pipe(Effect.flip)).code,
      "forbidden",
    );
    const defaults = yield* app.command(request, defaultsCommand);
    NodeAssert.equal(defaults.kind, "executionDefaults");
    NodeAssert.deepEqual(yield* app.command(request, defaultsCommand), defaults);
    NodeAssert.deepEqual(
      yield* app.query(operate, {
        op: "executionDefaults",
        factoryId: "p21-a",
        repository: "fixture-repo",
      }),
      defaults,
    );
    NodeAssert.equal(
      (yield* app.command(request, { ...defaultsCommand, model: "changed" }).pipe(Effect.flip))
        .code,
      "conflict",
    );
    NodeAssert.equal(
      (yield* app
        .command(request, { ...defaultsCommand, commandId: "p28-stale" })
        .pipe(Effect.flip)).code,
      "conflict",
    );
    const changedDefaults = yield* app.command(request, {
      ...defaultsCommand,
      commandId: "p28-update",
      expectedGeneration: 1,
      model: "updated-model",
    });
    if (changedDefaults.kind === "executionDefaults") {
      NodeAssert.equal(changedDefaults.defaults?.generation, 2);
      NodeAssert.equal(changedDefaults.defaults?.model, "updated-model");
    }
    NodeAssert.deepEqual(yield* app.command(request, defaultsCommand), defaults);
    NodeAssert.deepEqual(
      yield* app.query(operate, {
        op: "executionDefaults",
        factoryId: "p21-a",
        repository: "fixture-repo",
      }),
      changedDefaults,
    );
    NodeAssert.equal(
      (yield* sql`SELECT id FROM foundry_automation.runs WHERE factory_id='p21-a'`).length,
      0,
    );
    const largeFiles = exportFactoryFiles({
      schemaVersion: 1,
      factoryId: "p21-a",
      repositories: ["fixture-repo"],
      workflows: Array.from({ length: 8 }, (_, workflow) => ({
        id: `large-${workflow}`,
        steps: Array.from({ length: 12 }, (_, step) => ({
          id: `review-${step}`,
          kind: "approval" as const,
          dependsOn: [],
          prompt: "x".repeat(19000),
        })),
      })),
    });
    yield* sql`INSERT INTO foundry_automation.definition_git_revisions(id,factory_id,commit_sha,content_hash,valid,issues,files,created_at) VALUES('p21-large','p21-a',${"a".repeat(40)},NULL,true,'[]',${sql.json(largeFiles)},1)`;
    const metadata = yield* app.query(operate, {
      op: "definitionRevision",
      factoryId: "p21-a",
      revisionId: "p21-large",
    });
    NodeAssert.ok(encodeJson(metadata).length < 10000);
    if (metadata.kind === "definitionRevision") {
      NodeAssert.deepEqual(
        metadata.files,
        largeFiles.map((file) => file.path),
      );
      const file = yield* app.query(operate, {
        op: "definitionRevisionFile",
        factoryId: "p21-a",
        revisionId: "p21-large",
        path: largeFiles[1]!.path,
        side: "revision",
        activeVersionId: metadata.activeVersionId,
      });
      NodeAssert.equal(file.kind, "definitionRevisionFile");
      if (file.kind === "definitionRevisionFile")
        NodeAssert.deepEqual(file.file, {
          ...largeFiles[1],
          encoding: "utf8",
          size: Buffer.byteLength(largeFiles[1]!.content, "utf8"),
        });
      NodeAssert.ok(encodeJson(file).length < 3 * 1024 * 1024);
    }
    yield* app.command(operate, {
      op: "createWorkItem",
      input: {
        commandId: "p21-work",
        id: "p21-work",
        factoryId: "p21-a",
        versionId: active.version.factoryVersionId,
        repository: "fixture-repo",
        title: "Fixture work",
        source: { kind: "manual", reference: "gate" },
      },
    });
    const works = yield* app.query(operate, { op: "workItems", factoryId: "p21-a", limit: 1 });
    NodeAssert.equal(works.kind, "workItems");
    if (works.kind === "workItems") NodeAssert.equal(works.items[0]?.id, "p21-work");
    const runs = yield* app.query(operate, { op: "runs", factoryId: "p21-a", limit: 1 });
    NodeAssert.equal(runs.kind, "runs");
    if (runs.kind === "runs") NodeAssert.equal(runs.items.length, 0);
    NodeAssert.equal(
      (yield* app
        .query(operate, { op: "workItem", factoryId: "p21-b", workItemId: "p21-work" })
        .pipe(Effect.flip)).code,
      "not_found",
    );
    yield* sql`INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,state) VALUES('p21-private-run','p21-a','p21-work',${active.version.workflowVersions[0]!.versionId},${active.version.factoryVersionId},'fixture-repo','input-1','pending')`;
    const hiddenFactoryRuns = yield* app.query(machineB, { op: "runs", limit: 1 });
    if (hiddenFactoryRuns.kind === "runs") {
      NodeAssert.deepEqual(hiddenFactoryRuns.items, []);
      NodeAssert.equal(hiddenFactoryRuns.next, null);
    }
    const visibleFactoryRuns = yield* app.query(machineA, { op: "runs", limit: 1 });
    if (visibleFactoryRuns.kind === "runs")
      NodeAssert.deepEqual(
        visibleFactoryRuns.items.map((run) => [run.id, run.workflowName, run.enrolledAt]),
        [["p21-private-run", "main", null]],
      );
    for (const query of [
      { op: "run" as const, factoryId: "p21-b", runId: "p21-private-run" },
      { op: "attempts" as const, factoryId: "p21-b", runId: "p21-private-run", limit: 1 },
      {
        op: "attempt" as const,
        factoryId: "p21-b",
        runId: "p21-private-run",
        commandId: "private-attempt",
      },
    ])
      NodeAssert.equal((yield* app.query(machineB, query).pipe(Effect.flip)).code, "not_found");
    const pendingRun = yield* app.query(operate, {
      op: "run",
      factoryId: "p21-a",
      runId: "p21-private-run",
    });
    NodeAssert.equal(pendingRun.kind, "run");
    if (pendingRun.kind === "run") NodeAssert.equal(pendingRun.control, null);
    yield* sql`INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding) VALUES('p21-private-run','fixture-private-worker',${sql.json({ identity: { instanceId: identity.instanceId, operatorId: "another-operator" } })})`;
    for (const query of [
      { op: "run" as const, factoryId: "p21-a", runId: "p21-private-run" },
      { op: "attempts" as const, factoryId: "p21-a", runId: "p21-private-run", limit: 20 },
      {
        op: "attempt" as const,
        factoryId: "p21-a",
        runId: "p21-private-run",
        commandId: "private-attempt",
      },
    ]) {
      NodeAssert.equal((yield* app.query(operate, query).pipe(Effect.flip)).code, "forbidden");
      NodeAssert.equal((yield* app.query(machineA, query).pipe(Effect.flip)).code, "forbidden");
    }
    const hiddenRuns = yield* app.query(operate, { op: "runs", factoryId: "p21-a", limit: 20 });
    if (hiddenRuns.kind === "runs") NodeAssert.equal(hiddenRuns.items.length, 0);
    for (const [id, when] of [
      ["z-older-run", "2026-01-01T00:00:00Z"],
      ["a-newer-run", "2026-01-02T00:00:00Z"],
    ]) {
      yield* sql`INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,state) VALUES(${id},'p21-a','p21-work',${active.version.workflowVersions[0]!.versionId},${active.version.factoryVersionId},'fixture-repo','input-1','pending')`;
      yield* sql`INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding,enrolled_at) VALUES(${id},'fixture-worker',${sql.json({ identity, projectId: "worker-project", model: "fixture", checks: [], requiredArtifacts: [] })},${when}::timestamptz)`;
    }
    const publicWorkers = [
      {
        deviceId: "22222222-2222-4222-8222-222222222222",
        environmentId: "fixture-worker",
        projectId: "worker-project",
      },
    ];
    yield* sql`UPDATE foundry_automation.dispatch_runs SET binding=binding || ${sql.json({ workers: publicWorkers.map(({ projectId, ...target }) => ({ identity: { ...identity, ...target, deviceGeneration: 1, accessGeneration: 1, automationGeneration: 1, clientSessionId: "fixture-session", foundrySessionHash: "a".repeat(43) }, projectId })) })}::jsonb WHERE run_id='a-newer-run'`;
    for (const runId of ["a-newer-run", "z-older-run"]) {
      const detail = yield* app.query(operate, { op: "run", factoryId: "p21-a", runId });
      NodeAssert.equal(detail.kind, "run");
      if (detail.kind === "run") {
        NodeAssert.deepEqual(
          detail.executionBinding?.workers,
          runId === "a-newer-run" ? publicWorkers : undefined,
        );
      }
    }
    const recent = yield* app.query(operate, {
      op: "runs",
      factoryId: "p21-a",
      recent: true,
      limit: 1,
    });
    if (recent.kind === "runs") {
      NodeAssert.deepEqual(
        recent.items.map((run) => [run.id, run.workItemTitle, run.workflowName, run.enrolledAt]),
        [["a-newer-run", "Fixture work", "main", "2026-01-02T00:00:00.000Z"]],
      );
      NodeAssert.equal(recent.next, "a-newer-run");
      const nextRecent = yield* app.query(operate, {
        op: "runs",
        factoryId: "p21-a",
        recent: true,
        limit: 1,
        after: recent.next!,
      });
      if (nextRecent.kind === "runs") {
        NodeAssert.deepEqual(
          nextRecent.items.map((run) => [run.id, run.workflowName, run.enrolledAt]),
          [["z-older-run", "main", "2026-01-01T00:00:00.000Z"]],
        );
        NodeAssert.equal(nextRecent.next, null);
      }
    }
    const approvalNode = {
      id: "review",
      kind: "approval",
      instructions: "Review pinned result",
      dependsOn: [],
    } as const;
    const loopNode = {
      id: "loop",
      kind: "loop",
      dependsOn: [],
      maxIterations: 100,
      onExhausted: "fail",
      until: { eq: [{ value: false }, { value: true }] },
      steps: [approvalNode],
    } as const;
    const snapshot = {
      workflow: {
        id: "paged",
        limits: { maxConcurrentAgents: 1, maxAgentExecutions: 100 },
        steps: [loopNode],
      },
      agents: [],
      skills: [],
      mcp: [],
      files: [],
    };
    const nodeState = {
      status: "running",
      startedAgentExecutions: 0,
      inputs: {},
      nodes: [
        {
          path: "loop",
          scope: "",
          definition: loopNode,
          status: "running",
          base: "a".repeat(40),
          iteration: 100,
        },
        ...Array.from({ length: 100 }, (_, ordinal) => ({
          path: `loop/iteration-${ordinal + 1}/review`,
          scope: `loop/iteration-${ordinal + 1}`,
          definition: approvalNode,
          status: ordinal === 99 ? "ready" : "succeeded",
          base: "a".repeat(40),
          ordinal,
          output: { text: "x".repeat(60000) },
        })),
      ],
    };
    yield* sql`INSERT INTO foundry_automation.workflow_versions(id,factory_id,factory_version_id,steps,v4) VALUES('p21-v4-workflow','p21-a',${active.version.factoryVersionId},'[]',${sql.json(snapshot)})`;
    yield* sql`INSERT INTO foundry_automation.runs(id,factory_id,work_item_id,workflow_version_id,factory_version_id,repository,revision,state) VALUES('p21-v4-run','p21-a','p21-work','p21-v4-workflow',${active.version.factoryVersionId},'fixture-repo',${"a".repeat(40)},'pending')`;
    yield* sql`INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding,v4_state) VALUES('p21-v4-run','fixture-worker',${sql.json({ identity, projectId: "worker-project", model: "fixture", checks: [], requiredArtifacts: [] })},${sql.json(nodeState)})`;
    yield* sql`INSERT INTO foundry_automation.run_controls(run_id) VALUES('p21-v4-run')`;
    const modularRuns = yield* app.query(operate, { op: "runs", factoryId: "p21-a", limit: 20 });
    if (modularRuns.kind === "runs")
      NodeAssert.equal(
        modularRuns.items.find((run) => run.id === "p21-v4-run")?.workflowName,
        "paged",
      );
    const runtimePage = yield* app.query(operate, {
      op: "run",
      factoryId: "p21-a",
      runId: "p21-v4-run",
    });
    NodeAssert.equal(runtimePage.kind, "run");
    if (runtimePage.kind === "run") {
      NodeAssert.equal(runtimePage.runtimeState?.nodes.length, 100);
      NodeAssert.equal(runtimePage.runtimeState?.nodesTotal, 101);
      NodeAssert.equal(runtimePage.runtimeState?.nextNodeOffset, 100);
      NodeAssert.ok(encodeJson(runtimePage).length < 100000);
      NodeAssert.ok(!encodeJson(runtimePage).includes("x".repeat(100)));
    }
    const nextNodes = yield* app.query(operate, {
      op: "run",
      factoryId: "p21-a",
      runId: "p21-v4-run",
      nodesAfter: 100,
    });
    if (nextNodes.kind === "run") {
      NodeAssert.equal(nextNodes.runtimeState?.nodes[0]?.ordinal, 99);
      NodeAssert.equal(nextNodes.runtimeState?.nextNodeOffset, null);
      NodeAssert.equal(nextNodes.workflow.steps[0]?.id, "loop/iteration-100/review");
    }
    const node = yield* app.query(operate, {
      op: "runtimeNode",
      factoryId: "p21-a",
      runId: "p21-v4-run",
      path: "loop/iteration-100/review",
    });
    NodeAssert.equal(node.kind, "runtimeNode");
    if (node.kind === "runtimeNode")
      NodeAssert.deepEqual(node.node.output, { text: "x".repeat(60000) });
    NodeAssert.equal(
      (yield* app
        .query(machineB, {
          op: "runtimeNode",
          factoryId: "p21-a",
          runId: "p21-v4-run",
          path: "loop/iteration-100/review",
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    yield* sql`UPDATE foundry_automation.work_items SET state='completed' WHERE id='p21-work'`;
    const openWork = yield* app.query(operate, {
      op: "workItems",
      factoryId: "p21-a",
      activeOnly: true,
      limit: 20,
    });
    if (openWork.kind === "workItems") NodeAssert.deepEqual(openWork.items, []);
    const createdMachineWork = yield* app.command(machineStart, machineWork);
    NodeAssert.deepEqual(yield* app.command(machineStart, machineWork), createdMachineWork);
    NodeAssert.equal(
      (yield* sql`SELECT id FROM foundry_automation.work_items WHERE id='n06-work'`).length,
      1,
    );
    NodeAssert.equal(
      (yield* app
        .command(machineStart, {
          ...machineWork,
          input: { ...machineWork.input, factoryId: "p21-b" },
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    NodeAssert.equal(
      (yield* app.command(machineStart, create).pipe(Effect.flip)).code,
      "forbidden",
    );
  }).pipe(Effect.provide(Layer.merge(layer, database)), Effect.scoped);
});
