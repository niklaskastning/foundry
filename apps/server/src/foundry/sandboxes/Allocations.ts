import {
  FoundrySandboxAllocation,
  FoundrySandboxProfile,
  FoundrySandboxRequest,
  FoundrySandboxError,
  type FoundrySandboxState,
  type FoundrySandboxCleanupReceipt,
  type FoundryDeviceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InstanceDatabase from "../InstanceDatabase.ts";
import * as InstancePostgres from "../InstancePostgres.ts";
import { canTransition, reservesCapacity } from "./allocationState.ts";

const allocationLock = Effect.fn("SandboxAllocations.lock")(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  // Admission and lifecycle changes share the instance lock so quota cannot oversubscribe.
  yield* sql`SELECT pg_advisory_xact_lock(1179602514, 34)`;
});
export const withSandboxAllocationLock = Effect.fn("SandboxAllocations.withLock")(function* <
  A,
  E,
  R,
>(operation: Effect.Effect<A, E, R>) {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* allocationLock();
      return yield* operation;
    }),
  );
});

export class SandboxPolicy extends Context.Service<
  SandboxPolicy,
  {
    readonly supervisorDeviceId: FoundryDeviceId;
    readonly maxAllocations: number;
    readonly maxCpuMillis: number;
    readonly maxMemoryMiB: number;
    readonly allowedRepositories: ReadonlyArray<string>;
    readonly allowedImages: ReadonlyArray<string>;
  }
>()("t3/foundry/sandboxes/Allocations/SandboxPolicy") {}

type Row = {
  setup_log: string;
  allocation: FoundrySandboxAllocation;
  archive_receipt: FoundrySandboxCleanupReceipt | null;
};
export class Allocations extends Context.Service<
  Allocations,
  {
    readonly reportSetup: (
      operatorId: string,
      allocationId: string,
      generation: number,
      log: string,
    ) => Effect.Effect<void, FoundrySandboxError>;
    readonly findByCommand: (
      operatorId: string,
      commandId: string,
    ) => Effect.Effect<Row | null, FoundrySandboxError>;
    readonly activeWorkflowAllocations: Effect.Effect<
      ReadonlyArray<{ operatorId: string; allocation: FoundrySandboxAllocation }>,
      FoundrySandboxError
    >;
    readonly admitRuntime: (
      operatorId: string,
      allocationId: string,
      generation: number,
    ) => Effect.Effect<void, FoundrySandboxError>;
    readonly claim: (
      operatorId: string,
      leaseId: string,
    ) => Effect.Effect<ReadonlyArray<FoundrySandboxAllocation>, FoundrySandboxError>;
    readonly checkLease: (
      operatorId: string,
      allocationId: string,
      leaseId: string,
      generation: number,
    ) => Effect.Effect<Row, FoundrySandboxError>;
    readonly bind: (
      operatorId: string,
      allocationId: string,
      generation: number,
      environmentId: FoundrySandboxAllocation["environmentId"],
      deviceId: FoundrySandboxAllocation["deviceId"],
    ) => Effect.Effect<void, FoundrySandboxError>;
    readonly publishProfile: (
      operatorId: string,
      profile: FoundrySandboxProfile,
    ) => Effect.Effect<void, FoundrySandboxError>;
    readonly list: (operatorId: string) => Effect.Effect<
      {
        profiles: ReadonlyArray<FoundrySandboxProfile>;
        allocations: ReadonlyArray<FoundrySandboxAllocation>;
      },
      FoundrySandboxError
    >;
    readonly request: (
      operatorId: string,
      request: FoundrySandboxRequest,
    ) => Effect.Effect<FoundrySandboxAllocation, FoundrySandboxError>;
    readonly get: (
      operatorId: string,
      allocationId: string,
    ) => Effect.Effect<Row, FoundrySandboxError>;
    readonly control: (
      operatorId: string,
      allocationId: string,
      action: "stop" | "delete" | "retry" | "extend",
      expiresAt?: number,
    ) => Effect.Effect<FoundrySandboxAllocation, FoundrySandboxError>;
    readonly transition: (
      operatorId: string,
      allocationId: string,
      generation: number,
      state: FoundrySandboxState,
      patch?: Partial<
        Pick<FoundrySandboxAllocation, "environmentId" | "deviceId" | "projectId" | "failure">
      >,
      receipt?: FoundrySandboxCleanupReceipt,
    ) => Effect.Effect<FoundrySandboxAllocation, FoundrySandboxError>;
  }
>()("t3/foundry/sandboxes/Allocations") {}

const decodeProfile = Schema.decodeUnknownEffect(FoundrySandboxProfile, {
  onExcessProperty: "error",
});
const decodeRequest = Schema.decodeUnknownEffect(FoundrySandboxRequest, {
  onExcessProperty: "error",
});
const isError = Schema.is(FoundrySandboxError);
const failure = (error: unknown) =>
  isError(error)
    ? error
    : new FoundrySandboxError({
        code: Schema.isSchemaError(error) ? "invalid_request" : "unavailable",
      });
const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const lock = () =>
    allocationLock().pipe(Effect.provideService(InstanceDatabase.InstanceDatabase, sql));
  const identity = yield* InstancePostgres.InstancePostgres;
  const crypto = yield* Crypto.Crypto;
  const policy = yield* SandboxPolicy;
  const authorize = Effect.fn("SandboxAllocations.authorize")(function* (operatorId: string) {
    const instanceId = yield* identity.readIdentity;
    const rows =
      yield* sql`SELECT 1 FROM foundry_instance.operator_binding WHERE operator_id=${operatorId}`;
    if (!rows.length) return yield* new FoundrySandboxError({ code: "forbidden" });
    return instanceId;
  });

  const get = Effect.fn("SandboxAllocations.get")(function* (
    operatorId: string,
    allocationId: string,
  ) {
    const instanceId = yield* authorize(operatorId);
    const rows =
      yield* sql<Row>`SELECT allocation,archive_receipt,setup_log FROM foundry_instance.sandbox_allocations
      WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND allocation_id=${allocationId}`;
    if (!rows[0]) return yield* new FoundrySandboxError({ code: "not_found" });
    return rows[0];
  }, Effect.mapError(failure));
  const save = Effect.fn("SandboxAllocations.save")(function* (
    value: FoundrySandboxAllocation,
    receipt?: FoundrySandboxCleanupReceipt,
  ) {
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=${sql.json(value)},
      archive_receipt=COALESCE(${receipt ? sql.json(receipt) : null},archive_receipt)
      WHERE allocation_id=${value.allocationId}`;
    return value;
  });
  const publishProfile = Effect.fn("SandboxAllocations.publishProfile")(function* (
    operatorId: string,
    raw: FoundrySandboxProfile,
  ) {
    const instanceId = yield* authorize(operatorId);
    const profile = yield* decodeProfile(raw);
    if (
      !policy.allowedRepositories.includes(profile.checkout.repository) ||
      !policy.allowedImages.includes(profile.image) ||
      profile.resources.cpuMillis > policy.maxCpuMillis ||
      profile.resources.memoryMiB > policy.maxMemoryMiB ||
      profile.resources.pids > 1024 ||
      profile.lifetimeSeconds > profile.maxLifetimeSeconds ||
      profile.maxLifetimeSeconds > 86400
    )
      return yield* new FoundrySandboxError({ code: "forbidden" });
    const rows =
      yield* sql`INSERT INTO foundry_instance.sandbox_profiles(profile_id,revision,instance_id,operator_id,profile)
      VALUES(${profile.profileId},${profile.revision},${instanceId},${operatorId},${sql.json(profile)})
      ON CONFLICT DO NOTHING RETURNING revision`;
    if (!rows.length) {
      const same =
        yield* sql`SELECT 1 FROM foundry_instance.sandbox_profiles WHERE instance_id=${instanceId}
        AND operator_id=${operatorId} AND profile_id=${profile.profileId} AND revision=${profile.revision} AND profile=${sql.json(profile)}`;
      if (!same.length) return yield* new FoundrySandboxError({ code: "conflict" });
    }
  }, Effect.mapError(failure));
  const list = Effect.fn("SandboxAllocations.list")(function* (operatorId: string) {
    const instanceId = yield* authorize(operatorId);
    const profiles = yield* sql<{
      profile: FoundrySandboxProfile;
    }>`SELECT profile FROM foundry_instance.sandbox_profiles
      WHERE instance_id=${instanceId} AND operator_id=${operatorId} ORDER BY profile_id,revision LIMIT 128`;
    const allocations = yield* sql<Row>`SELECT allocation FROM foundry_instance.sandbox_allocations
      WHERE instance_id=${instanceId} AND operator_id=${operatorId} ORDER BY (allocation->>'createdAt')::bigint DESC LIMIT 128`;
    return {
      profiles: profiles.map((row) => row.profile),
      allocations: allocations.map((row) => row.allocation),
    };
  }, Effect.mapError(failure));
  const request = Effect.fn("SandboxAllocations.request")(function* (
    operatorId: string,
    raw: FoundrySandboxRequest,
  ) {
    const input = yield* decodeRequest(raw);
    const instanceId = yield* authorize(operatorId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        const old = yield* sql<Row>`SELECT allocation FROM foundry_instance.sandbox_allocations
        WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND command_id=${input.commandId}`;
        if (old[0]) {
          const same =
            yield* sql`SELECT 1 FROM foundry_instance.sandbox_allocations WHERE allocation_id=${old[0].allocation.allocationId}
          AND allocation->'request'=${sql.json(input)}`;
          if (!same.length) return yield* new FoundrySandboxError({ code: "conflict" });
          return old[0].allocation;
        }
        const profiles = yield* sql<{
          profile: FoundrySandboxProfile;
        }>`SELECT profile FROM foundry_instance.sandbox_profiles
        WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND profile_id=${input.profileId} AND revision=${input.revision}`;
        const profile = profiles[0]?.profile;
        if (!profile?.enabled) return yield* new FoundrySandboxError({ code: "not_found" });
        if (
          !policy.allowedRepositories.includes(profile.checkout.repository) ||
          !policy.allowedImages.includes(profile.image)
        )
          return yield* new FoundrySandboxError({ code: "forbidden" });
        if (input.resumeAllocationId) {
          const previous = yield* get(operatorId, input.resumeAllocationId);
          if (
            !previous.archive_receipt ||
            "archive" in previous.archive_receipt ||
            previous.allocation.state !== "deleted"
          )
            return yield* new FoundrySandboxError({ code: "archive_required" });
          if (
            previous.allocation.profile.checkout.repository !== profile.checkout.repository ||
            (input.resumeThreadId &&
              !(
                "threads" in previous.archive_receipt &&
                previous.archive_receipt.threads.some(
                  (thread) => thread.manifest.owner.threadId === input.resumeThreadId,
                )
              ))
          )
            return yield* new FoundrySandboxError({ code: "invalid_request" });
        }
        const active =
          yield* sql<Row>`SELECT allocation FROM foundry_instance.sandbox_allocations WHERE instance_id=${instanceId}
        AND allocation->>'state' <> 'deleted'`;
        const reserved = active.filter((row) => reservesCapacity(row.allocation.state));
        if (
          reserved.length >= policy.maxAllocations ||
          reserved.reduce(
            (sum, row) => sum + row.allocation.profile.resources.cpuMillis,
            profile.resources.cpuMillis,
          ) > policy.maxCpuMillis ||
          reserved.reduce(
            (sum, row) => sum + row.allocation.profile.resources.memoryMiB,
            profile.resources.memoryMiB,
          ) > policy.maxMemoryMiB
        )
          return yield* new FoundrySandboxError({ code: "capacity" });
        const now = yield* Clock.currentTimeMillis;
        const allocation: FoundrySandboxAllocation = {
          allocationId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
          request: input,
          profile,
          state: "requested",
          generation: 1,
          createdAt: now,
          expiresAt: now + profile.lifetimeSeconds * 1000,
          environmentId: null,
          deviceId: null,
          projectId: null,
          failure: null,
          deleteRequested: false,
          failureFrom: null,
          setupAdmitted: false,
          runtimeAdmitted: false,
        };
        yield* sql`INSERT INTO foundry_instance.sandbox_allocations(allocation_id,instance_id,operator_id,command_id,allocation)
        VALUES(${allocation.allocationId},${instanceId},${operatorId},${input.commandId},${sql.json(allocation)})`;
        return allocation;
      }),
    );
  }, Effect.mapError(failure));
  const control = Effect.fn("SandboxAllocations.control")(function* (
    operatorId: string,
    allocationId: string,
    action: "stop" | "delete" | "retry" | "extend",
    expiresAt?: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        const { allocation } = yield* get(operatorId, allocationId);
        if (allocation.state === "deleted") {
          if (action === "delete" || action === "stop") return allocation;
          return yield* new FoundrySandboxError({ code: "conflict" });
        }
        if (action === "extend") {
          const now = yield* Clock.currentTimeMillis;
          if (
            !expiresAt ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now ||
            expiresAt < allocation.expiresAt ||
            expiresAt > allocation.createdAt + allocation.profile.maxLifetimeSeconds * 1000 ||
            !["requested", "provisioning", "setup", "ready"].includes(allocation.state) ||
            allocation.expiresAt <= now
          )
            return yield* new FoundrySandboxError({ code: "conflict" });
          return yield* save({ ...allocation, expiresAt });
        }
        if (action === "retry") {
          if (allocation.state !== "failed" || !allocation.failureFrom)
            return yield* new FoundrySandboxError({ code: "conflict" });
          const cleanup = ["draining", "stopped", "archiving", "deleting"].includes(
            allocation.failureFrom,
          );
          if (
            !cleanup &&
            (allocation.deleteRequested || allocation.expiresAt <= (yield* Clock.currentTimeMillis))
          )
            return yield* new FoundrySandboxError({ code: "conflict" });
          const state =
            allocation.failureFrom === "ready" || allocation.failureFrom === "requested"
              ? "provisioning"
              : allocation.failureFrom;
          return yield* save({
            ...allocation,
            state,
            generation: allocation.generation + (cleanup ? 0 : 1),
            failure: null,
            failureFrom: null,
          });
        }
        if (["draining", "stopped", "archiving", "deleting"].includes(allocation.state))
          return yield* save({
            ...allocation,
            deleteRequested: allocation.deleteRequested || action === "delete",
          });
        return yield* save({
          ...allocation,
          state: "draining",
          generation: allocation.generation + 1,
          deleteRequested: action === "delete",
        });
      }),
    );
  }, Effect.mapError(failure));
  const transition = Effect.fn("SandboxAllocations.transition")(function* (
    operatorId: string,
    allocationId: string,
    generation: number,
    state: FoundrySandboxState,
    patch: Partial<
      Pick<FoundrySandboxAllocation, "environmentId" | "deviceId" | "projectId" | "failure">
    > = {},
    receipt?: FoundrySandboxCleanupReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        const row = yield* get(operatorId, allocationId);
        if (row.allocation.generation !== generation || !canTransition(row.allocation.state, state))
          return yield* new FoundrySandboxError({ code: "conflict" });
        if (state === "deleting" && !receipt && !row.archive_receipt)
          return yield* new FoundrySandboxError({ code: "archive_required" });
        const receiptIdentity = receipt
          ? "archive" in receipt
            ? receipt.archive
            : receipt
          : undefined;
        if (
          receiptIdentity &&
          (receiptIdentity.allocationId !== allocationId || receiptIdentity.fence !== generation)
        )
          return yield* new FoundrySandboxError({ code: "conflict" });
        return yield* save(
          {
            ...row.allocation,
            ...patch,
            state,
            failureFrom: state === "failed" ? row.allocation.state : null,
            setupAdmitted: row.allocation.setupAdmitted || state === "setup",
          },
          receipt,
        );
      }),
    );
  }, Effect.mapError(failure));
  const claim = Effect.fn("SandboxAllocations.claim")(function* (
    operatorId: string,
    leaseId: string,
  ) {
    const instanceId = yield* authorize(operatorId);
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=jsonb_set(jsonb_set(jsonb_set(allocation,
        '{state}', '"draining"'::jsonb),'{deleteRequested}','true'::jsonb),'{generation}',to_jsonb((allocation->>'generation')::integer+1))
        WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND (allocation->>'expiresAt')::bigint<=${now}
        AND (allocation->>'state' IN ('requested','provisioning','setup','ready','failed') OR (allocation->>'state'='stopped' AND allocation->>'deleteRequested'='false'))`;
        const rows =
          yield* sql<Row>`UPDATE foundry_instance.sandbox_allocations SET claim_owner=${leaseId},claim_until=${now + 60000}
        WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND allocation->>'state'<>'deleted'
        AND (claim_owner=${leaseId} OR claim_until<${now}) RETURNING allocation`;
        return rows.map((row) => row.allocation);
      }),
    );
  }, Effect.mapError(failure));
  const checkLease = Effect.fn("SandboxAllocations.checkLease")(function* (
    operatorId: string,
    allocationId: string,
    leaseId: string,
    generation: number,
  ) {
    const row = yield* get(operatorId, allocationId);
    const now = yield* Clock.currentTimeMillis;
    const leased =
      yield* sql`SELECT 1 FROM foundry_instance.sandbox_allocations WHERE allocation_id=${allocationId}
      AND claim_owner=${leaseId} AND claim_until>${now}`;
    if (!leased.length || row.allocation.generation !== generation)
      return yield* new FoundrySandboxError({ code: "conflict" });
    return row;
  }, Effect.mapError(failure));
  const bind = Effect.fn("SandboxAllocations.bind")(function* (
    operatorId: string,
    allocationId: string,
    generation: number,
    environmentId: FoundrySandboxAllocation["environmentId"],
    deviceId: FoundrySandboxAllocation["deviceId"],
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        const { allocation } = yield* get(operatorId, allocationId);
        if (
          allocation.generation !== generation ||
          allocation.state !== "setup" ||
          (allocation.environmentId !== null && allocation.environmentId !== environmentId) ||
          (allocation.deviceId !== null && allocation.deviceId !== deviceId)
        )
          return yield* new FoundrySandboxError({ code: "conflict" });
        if (environmentId) {
          const other =
            yield* sql`SELECT 1 FROM foundry_instance.sandbox_allocations WHERE allocation_id<>${allocationId} AND allocation->>'environmentId'=${environmentId}`;
          if (other.length) return yield* new FoundrySandboxError({ code: "conflict" });
        }
        yield* save({ ...allocation, environmentId, deviceId });
      }),
    );
  }, Effect.mapError(failure));
  const admitRuntime = Effect.fn("SandboxAllocations.admitRuntime")(function* (
    operatorId: string,
    allocationId: string,
    generation: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock();
        const { allocation } = yield* get(operatorId, allocationId);
        if (
          allocation.generation !== generation ||
          allocation.state !== "setup" ||
          !allocation.deviceId
        )
          return yield* new FoundrySandboxError({ code: "conflict" });
        yield* save({ ...allocation, runtimeAdmitted: true });
      }),
    );
  }, Effect.mapError(failure));
  const findByCommand = Effect.fn("SandboxAllocations.findByCommand")(function* (
    operatorId: string,
    commandId: string,
  ) {
    const instanceId = yield* authorize(operatorId);
    const rows =
      yield* sql<Row>`SELECT allocation,archive_receipt,setup_log FROM foundry_instance.sandbox_allocations
      WHERE instance_id=${instanceId} AND operator_id=${operatorId} AND command_id=${commandId}`;
    return rows[0] ?? null;
  }, Effect.mapError(failure));
  const activeWorkflowAllocations = Effect.gen(function* () {
    const instanceId = yield* identity.readIdentity;
    return yield* sql<{
      operatorId: string;
      allocation: FoundrySandboxAllocation;
    }>`SELECT operator_id AS "operatorId",allocation FROM foundry_instance.sandbox_allocations
      WHERE instance_id=${instanceId} AND allocation->>'state'<>'deleted' AND allocation->'request'->'owner'->>'kind'='workflow'`;
  }).pipe(Effect.mapError(failure));
  const reportSetup = Effect.fn("SandboxAllocations.reportSetup")(function* (
    operatorId: string,
    allocationId: string,
    generation: number,
    log: string,
  ) {
    const instanceId = yield* authorize(operatorId);
    if (log.length > 65536) return yield* new FoundrySandboxError({ code: "invalid_request" });
    const rows =
      yield* sql`UPDATE foundry_instance.sandbox_allocations SET setup_log=${log} WHERE allocation_id=${allocationId}
      AND instance_id=${instanceId} AND operator_id=${operatorId} AND (allocation->>'generation')::integer=${generation}
      AND allocation->>'state' IN ('setup','failed') RETURNING allocation_id`;
    if (!rows.length) return yield* new FoundrySandboxError({ code: "conflict" });
  }, Effect.mapError(failure));
  return Allocations.of({
    reportSetup,
    findByCommand,
    activeWorkflowAllocations,
    admitRuntime,
    publishProfile,
    list,
    request,
    get,
    control,
    transition,
    claim,
    checkLease,
    bind,
  });
});
export const layer = Layer.effect(Allocations, make);
