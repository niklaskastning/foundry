import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AuthSessionId,
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundrySandboxError,
  ProjectId,
  type FoundrySandboxAllocation,
  type FoundrySandboxRequest,
} from "@t3tools/contracts";
import * as Allocations from "../foundry/sandboxes/Allocations.ts";
import * as Database from "./AutomationDatabase.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as SandboxTargets from "./SandboxTargets.ts";

const unused = (): never => {
  throw new Error("This test must not execute SQL");
};
const database = Layer.mock(Database.AutomationDatabase)({
  "~effect/sql/SqlClient": "~effect/sql/SqlClient",
  "~@effect/sql-pg/PgClient": "~@effect/sql-pg/PgClient",
  config: {},
  literal: unused,
  in: unused,
  insert: unused,
  update: unused,
  updateValues: unused,
  and: unused,
  or: unused,
  csv: unused,
  join: unused,
  onDialect: unused,
  onDialectOrElse: unused,
  json: unused,
  listen: unused,
  withoutTransforms: unused,
});

it.effect("keeps optional sandbox dispatch disabled without an allocation service", () =>
  Effect.gen(function* () {
    assert.equal(yield* SandboxTargets.SandboxTargets, undefined);
  }).pipe(
    Effect.provide(
      SandboxTargets.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(WorkerTransport.WorkerTransport)({}),
            database,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  ),
);

it.effect(
  "pins workflow allocation requests and separates setup, capacity, deletion and ready authority",
  () => {
    const identity: WorkerTransport.WorkerIdentity = {
      instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
      operatorId: "operator",
      deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
      environmentId: EnvironmentId.make("source"),
      deviceGeneration: 1,
      accessGeneration: 1,
      automationGeneration: 1,
      clientSessionId: AuthSessionId.make("original-session"),
      foundrySessionHash: "a".repeat(43),
    };
    const profile = {
      profileId: "linux",
      revision: "33333333-3333-4333-8333-333333333333",
      label: "Linux",
      image: `fixture/image@sha256:${"a".repeat(64)}`,
      architecture: "amd64" as const,
      resources: { cpuMillis: 1000, memoryMiB: 512, pids: 128 },
      lifetimeSeconds: 600,
      maxLifetimeSeconds: 1200,
      network: "configured" as const,
      checkout: { repository: "https://example.com/repo", commit: "a".repeat(40) },
      setup: [],
      tools: [],
      providerConnectionId: "central",
      enabled: true,
    };
    const request: FoundrySandboxRequest = {
      commandId: "fixture",
      profileId: profile.profileId,
      revision: profile.revision,
      owner: { kind: "workflow", factoryId: "factory", runId: "run" },
    };
    let allocation: FoundrySandboxAllocation = {
      allocationId: "44444444-4444-4444-8444-444444444444",
      request,
      profile,
      state: "setup",
      generation: 1,
      createdAt: 0,
      expiresAt: 1000000,
      environmentId: EnvironmentId.make("sandbox"),
      deviceId: FoundryDeviceId.make("55555555-5555-4555-8555-555555555555"),
      projectId: ProjectId.make("sandbox-project"),
      failure: null,
      failureFrom: null,
      deleteRequested: false,
      setupAdmitted: true,
      runtimeAdmitted: true,
    };
    let capacity = false;
    const requests: FoundrySandboxRequest[] = [];
    const run = { id: "run", factoryId: "factory", revision: profile.checkout.commit };
    return Effect.gen(function* () {
      const targets = yield* SandboxTargets.SandboxTargets;
      assert.ok(targets);
      yield* targets.validate(identity.operatorId, profile, run.revision);
      const invalid = yield* targets
        .validate(identity.operatorId, profile, "b".repeat(40))
        .pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      assert.deepEqual(yield* targets.resolve(identity, profile, run), {
        state: "waiting",
        reason: "sandbox_setup",
      });
      capacity = true;
      assert.deepEqual(yield* targets.resolve(identity, profile, run), {
        state: "waiting",
        reason: "sandbox_capacity_unavailable",
      });
      capacity = false;
      allocation = { ...allocation, state: "ready" };
      const ready = yield* targets.resolve(identity, profile, run);
      assert.equal(ready.state, "ready");
      if (ready.state === "ready") {
        assert.equal(ready.projectId, allocation.projectId);
        assert.equal(ready.identity.deviceId, allocation.deviceId);
        assert.equal(
          "clientSessionId" in ready.identity && ready.identity.clientSessionId,
          identity.clientSessionId,
        );
      }
      assert.equal(new Set(requests.map((value) => value.commandId)).size, 1);
      assert.deepEqual(requests[0]?.owner, request.owner);
      assert.equal(requests[0]?.revision, profile.revision);
      allocation = { ...allocation, state: "draining" };
      assert.deepEqual(yield* targets.resolve(identity, profile, run), {
        state: "waiting",
        reason: "sandbox_draining",
      });
      allocation = { ...allocation, state: "deleted" };
      assert.deepEqual(yield* targets.resolve(identity, profile, run), {
        state: "failed",
        reason: "sandbox_deleted",
      });
    }).pipe(
      Effect.provide(
        SandboxTargets.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Allocations.Allocations)({
                list: () =>
                  Effect.succeed({
                    profiles: [{ ...profile, setupStepCount: 0 }],
                    allocations: [],
                  }),
                request: (_operator, input) =>
                  Effect.suspend(() => {
                    requests.push(input);
                    return capacity
                      ? Effect.fail(new FoundrySandboxError({ code: "capacity" }))
                      : Effect.succeed(allocation);
                  }),
              }),
              Layer.mock(WorkerTransport.WorkerTransport)({
                retargetSandbox: (source, target) => Effect.succeed({ ...source, ...target }),
              }),
              database,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
    );
  },
);
