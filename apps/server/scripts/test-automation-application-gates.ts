// @effect-diagnostics nodeBuiltinImport:off -- Assertions run inside the isolated PostgreSQL harness.
import * as NodeAssert from "node:assert/strict";
import {
  AutomationApplicationError,
  FoundryGatewayError,
  FoundryInstanceId,
  EnvironmentId,
  FoundryDeviceId,
  AutomationControlError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { exportFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Application from "../src/automation/Application.ts";
import * as Database from "../src/automation/AutomationDatabase.ts";
import * as Factories from "../src/automation/Factories.ts";
import * as Definitions from "../src/automation/Definitions.ts";
import * as Workflows from "../src/automation/Workflows.ts";
import * as Scheduler from "../src/automation/Scheduler.ts";
import * as Control from "../src/automation/Control.ts";
import * as WorkerTransport from "../src/automation/WorkerTransport.ts";
import * as GatewayGrants from "../src/foundry/GatewayGrants.ts";

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
      identityForRead: Effect.fn("ApplicationGate.gatewayIdentity")(() => Effect.succeed(identity)),
      identityForWrite: Effect.fn("ApplicationGate.authorize")(function* (request, scope) {
        if (request.headers["x-fixture-scope"] !== scope)
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
  const layer = Application.layer.pipe(
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
  }).pipe(Effect.provide(layer));
});
