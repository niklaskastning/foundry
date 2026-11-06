import * as SandboxGatewayAccess from "../src/foundry/SandboxGatewayAccess.ts";
import * as NodeAssert from "node:assert/strict";
import {
  EnvironmentId,
  FoundryDeviceId,
  ProviderInstanceId,
  type FoundryInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as InstanceDatabase from "../src/foundry/InstanceDatabase.ts";
import * as ProviderConnections from "../src/foundry/ProviderConnections.ts";
import * as ProviderConnectionAuth from "../src/foundry/ProviderConnectionAuth.ts";

export const verifyProviderConnections = Effect.fn("verifyProviderConnections")(function* (owner: {
  readonly instanceId: FoundryInstanceId;
  readonly operatorId: string;
}) {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + 600_000;
  const refreshing = yield* Deferred.make<void>();
  const resumeRefresh = yield* Deferred.make<void>();
  let blockRefresh = false;
  const auth = Layer.succeed(ProviderConnectionAuth.ProviderConnectionAuth, {
    currentProfile: Effect.fn("FixtureProviderConnectionAuth.currentProfile")(() =>
      Effect.succeed({ profileKey: "a".repeat(64) }),
    ),
    access: Effect.fn("FixtureProviderConnectionAuth.access")(function* () {
      if (blockRefresh) {
        yield* Deferred.succeed(refreshing, undefined);
        yield* Deferred.await(resumeRefresh);
      }
      return { accessToken: Redacted.make("fixture-central-access"), expiresAt };
    }),
  });
  const connection = {
    id: "provider-allocation-fixture",
    label: "Fixture",
    providerInstanceId: ProviderInstanceId.make("central-fixture"),
    profileKey: "a".repeat(64),
    generation: 1,
    grants: [],
  };
  const devices = [0, 1].map((index) => ({
    deviceId: FoundryDeviceId.make(`71ec7712-154a-4b61-9035-cc069be3a78${index}`),
    instanceId: owner.instanceId,
    environmentId: EnvironmentId.make(`provider-fixture-${index}`),
    publicKey: String(index).repeat(43),
    generation: 1,
    revoked: false,
  }));
  const allocations = [
    "a1ee19ef-c519-413c-bd59-a4cc76d6bb00",
    "a1ee19ef-c519-413c-bd59-a4cc76d6bb01",
  ];
  yield* Effect.forEach(
    devices,
    (
      device,
    ) => sql`INSERT INTO foundry_instance.devices(device_id,instance_id,operator_id,environment_id,public_key)
    VALUES(${device.deviceId},${owner.instanceId},${owner.operatorId},${device.environmentId},${device.publicKey})`,
  );
  yield* Effect.forEach(
    devices,
    (
      device,
      index,
    ) => sql`INSERT INTO foundry_instance.sandbox_allocations(allocation_id,instance_id,operator_id,command_id,allocation)
    VALUES(${allocations[index]!},${owner.instanceId},${owner.operatorId},${`provider-fixture-${index}`},${sql.json(
      {
        state: "setup",
        generation: 1,
        deleteRequested: false,
        failureFrom: null,
        deviceId: device.deviceId,
        environmentId: device.environmentId,
        expiresAt,
        request: { owner: { kind: "interactive" } },
        profile: { providerConnectionId: connection.id },
      },
    )})`,
  );
  yield* Effect.gen(function* () {
    const service = yield* ProviderConnections.ProviderConnections;
    const access = yield* SandboxGatewayAccess.SandboxGatewayAccess.pipe(
      Effect.provide(SandboxGatewayAccess.layer),
    );
    const target = {
      ...owner,
      deviceId: devices[1]!.deviceId,
      environmentId: devices[1]!.environmentId,
    };
    NodeAssert.equal((yield* access.validateDevice(target).pipe(Effect.result))._tag, "Failure");
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(allocation,'{state}','"ready"') WHERE allocation_id=${allocations[1]!}`;
    yield* access.validateDevice(target);
    yield* access.validateDevice({
      ...target,
      deviceId: FoundryDeviceId.make("8de1e586-92be-4c97-93b1-656d30f4cab4"),
    });

    const connected = yield* service.connect(owner, {
      id: connection.id,
      label: connection.label,
      providerInstanceId: connection.providerInstanceId,
      expectedGeneration: null,
    });
    NodeAssert.equal(connected.profileKey, connection.profileKey);
    const grant = (index: number) => ({
      connectionId: connection.id,
      device: devices[index]!,
      allocationId: allocations[index]!,
      factoryId: null,
    });
    const issue = (index: number) =>
      service.issue({
        ...owner,
        connectionId: connection.id,
        generation: 1,
        deviceId: devices[index]!.deviceId,
        deviceGeneration: 1,
        allocationId: allocations[index]!,
        factoryId: null,
      });
    NodeAssert.equal((yield* issue(0).pipe(Effect.flip)).code, "forbidden");
    const granted = yield* Effect.forEach(
      [0, 1],
      (index) => service.authorizeAllocation(owner, grant(index)),
      { concurrency: 2 },
    );
    NodeAssert.deepEqual(
      granted.map((value) => value.generation),
      [1, 1],
    );
    NodeAssert.equal((yield* service.authorizeAllocation(owner, grant(0))).grants.length, 2);
    for (const index of [0, 1]) {
      const issued = yield* issue(index);
      NodeAssert.equal(issued.expiresAt, expiresAt);
      NodeAssert.equal(Redacted.value(issued.accessToken), "fixture-central-access");
    }
    NodeAssert.equal(
      (yield* service
        .authorizeAllocation(owner, { ...grant(0), device: devices[1]! })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(allocation,'{state}','"draining"') WHERE allocation_id=${allocations[0]!}`;
    NodeAssert.equal((yield* issue(0).pipe(Effect.flip)).code, "forbidden");
    yield* service.releaseAllocation(owner, {
      connectionId: connection.id,
      allocationId: allocations[0]!,
    });
    yield* service.releaseAllocation(owner, {
      connectionId: connection.id,
      allocationId: allocations[0]!,
    });
    NodeAssert.equal(
      (yield* service.list(owner)).find((value) => value.id === connection.id)?.grants.length,
      1,
    );
    yield* issue(1);
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(allocation,'{expiresAt}',${sql.json(now - 1)}) WHERE allocation_id=${allocations[1]!}`;
    NodeAssert.equal((yield* issue(1).pipe(Effect.flip)).code, "forbidden");
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(allocation,'{expiresAt}',${sql.json(expiresAt)}) WHERE allocation_id=${allocations[1]!}`;
    blockRefresh = true;
    const inFlight = yield* issue(1).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(refreshing);
    const revoked = yield* service.revoke(owner, connection.id);
    NodeAssert.equal(revoked.lastIssuedExpiresAt, expiresAt);
    NodeAssert.equal((yield* access.validateDevice(target).pipe(Effect.result))._tag, "Failure");
    const fenced = yield* sql<{
      state: string;
      generation: number;
      deleteRequested: boolean;
    }>`SELECT allocation->>'state' AS state,(allocation->>'generation')::integer AS generation,(allocation->>'deleteRequested')::boolean AS "deleteRequested" FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocations[1]!}`;
    NodeAssert.deepEqual(fenced[0], { state: "draining", generation: 2, deleteRequested: true });
    yield* service.revoke(owner, connection.id);
    const repeated = yield* sql<{
      generation: number;
    }>`SELECT (allocation->>'generation')::integer AS generation FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocations[1]!}`;
    NodeAssert.equal(repeated[0]?.generation, 2);

    yield* Deferred.succeed(resumeRefresh, undefined);
    const result = yield* Fiber.join(inFlight);
    NodeAssert.equal(result._tag, "Failure");
    if (result._tag === "Failure") NodeAssert.equal(result.failure.code, "forbidden");
    NodeAssert.equal(
      (yield* service.authorizeAllocation(owner, grant(1)).pipe(Effect.flip)).code,
      "forbidden",
    );

    blockRefresh = false;
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=allocation || ${sql.json({ state: "ready", generation: 3, deleteRequested: false })}::jsonb WHERE allocation_id=${allocations[1]!}`;
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=allocation || ${sql.json({ state: "ready", generation: 3, deleteRequested: false, profile: { providerConnectionId: "unrelated-connection" } })}::jsonb WHERE allocation_id=${allocations[0]!}`;
    yield* service.connect(owner, {
      id: connection.id,
      label: connection.label,
      providerInstanceId: connection.providerInstanceId,
      expectedGeneration: 1,
    });
    const replaced = yield* sql<{
      state: string;
      generation: number;
    }>`SELECT allocation->>'state' AS state,(allocation->>'generation')::integer AS generation FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocations[1]!}`;
    NodeAssert.deepEqual(replaced[0], { state: "draining", generation: 4 });
    const unrelated = yield* sql<{
      state: string;
      generation: number;
    }>`SELECT allocation->>'state' AS state,(allocation->>'generation')::integer AS generation FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocations[0]!}`;
    NodeAssert.deepEqual(unrelated[0], { state: "ready", generation: 3 });
    for (const [state, failureFrom, expected] of [
      ["stopped", null, "stopped"],
      ["archiving", null, "archiving"],
      ["deleting", null, "deleting"],
      ["failed", "deleting", "deleting"],
    ] as const) {
      yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=allocation || ${sql.json({ state, failureFrom, generation: 5 })}::jsonb WHERE allocation_id=${allocations[1]!}`;
      yield* service.revoke(owner, connection.id);
      const cleanup = yield* sql<{
        state: string;
        generation: number;
      }>`SELECT allocation->>'state' AS state,(allocation->>'generation')::integer AS generation FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocations[1]!}`;
      NodeAssert.deepEqual(cleanup[0], { state: expected, generation: 5 });
    }
  }).pipe(Effect.provide(ProviderConnections.layer.pipe(Layer.provide(auth))));
  yield* sql`DELETE FROM foundry_instance.provider_connections WHERE id=${connection.id}`;
  yield* Effect.forEach(
    allocations,
    (id) => sql`DELETE FROM foundry_instance.sandbox_allocations WHERE allocation_id=${id}`,
  );
  yield* Effect.forEach(
    devices,
    (device) => sql`DELETE FROM foundry_instance.devices WHERE device_id=${device.deviceId}`,
  );
});
