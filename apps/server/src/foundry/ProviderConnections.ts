import { withSandboxAllocationLock } from "./sandboxes/Allocations.ts";
import {
  FoundryProviderConnection,
  FoundryProviderConnectionError,
  SetFoundryProviderConnection,
  ConnectFoundryProviderConnection,
  type FoundryInstanceId,
  type FoundryProviderGrant,
  type FoundryDevice,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as ProviderConnectionAuth from "./ProviderConnectionAuth.ts";

type Owner = { readonly instanceId: FoundryInstanceId; readonly operatorId: string };
type AllocationGrant = {
  readonly connectionId: string;
  readonly device: FoundryDevice;
  readonly allocationId: string;
  readonly factoryId: string | null;
};
type Issue = Owner &
  FoundryProviderGrant & { readonly connectionId: string; readonly generation: number };
const decode = Schema.decodeUnknownEffect(FoundryProviderConnection);
const decodeConnect = Schema.decodeEffect(ConnectFoundryProviderConnection);
const decodeSet = Schema.decodeUnknownEffect(SetFoundryProviderConnection, {
  onExcessProperty: "error",
});
const forbidden = () => new FoundryProviderConnectionError({ code: "forbidden" });
const failures = {
  SqlError: () => Effect.fail(new FoundryProviderConnectionError({ code: "unavailable" })),
  InstanceDatabaseError: () =>
    Effect.fail(new FoundryProviderConnectionError({ code: "unavailable" })),
  SchemaError: () => Effect.fail(new FoundryProviderConnectionError({ code: "invalid_input" })),
};

export class ProviderConnections extends Context.Service<
  ProviderConnections,
  {
    readonly connect: (
      owner: Owner,
      input: ConnectFoundryProviderConnection,
    ) => Effect.Effect<FoundryProviderConnection, FoundryProviderConnectionError>;
    readonly list: (
      owner: Owner,
    ) => Effect.Effect<readonly FoundryProviderConnection[], FoundryProviderConnectionError>;
    readonly set: (
      owner: Owner,
      input: SetFoundryProviderConnection,
    ) => Effect.Effect<FoundryProviderConnection, FoundryProviderConnectionError>;
    readonly revoke: (
      owner: Owner,
      id: string,
    ) => Effect.Effect<{ readonly lastIssuedExpiresAt: number }, FoundryProviderConnectionError>;
    readonly authorizeAllocation: (
      owner: Owner,
      input: AllocationGrant,
    ) => Effect.Effect<FoundryProviderConnection, FoundryProviderConnectionError>;
    readonly releaseAllocation: (
      owner: Owner,
      input: { readonly connectionId: string; readonly allocationId: string },
    ) => Effect.Effect<void, FoundryProviderConnectionError>;
    readonly issue: (
      input: Issue,
    ) => ReturnType<ProviderConnectionAuth.ProviderConnectionAuth["Service"]["access"]>;
  }
>()("t3/foundry/ProviderConnections") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const auth = yield* ProviderConnectionAuth.ProviderConnectionAuth;
  const checkOwner = Effect.fn("ProviderConnections.checkOwner")(function* (owner: Owner) {
    if ((yield* identity.readIdentity) !== owner.instanceId) return yield* forbidden();
    const rows =
      yield* sql`SELECT operator_id FROM foundry_instance.operator_binding WHERE operator_id=${owner.operatorId}`;
    if (!rows[0]) return yield* forbidden();
  });
  const list = Effect.fn("ProviderConnections.list")(function* (owner: Owner) {
    yield* checkOwner(owner);
    const rows = yield* sql<{
      connection: unknown;
      revoked: boolean;
      lastIssuedExpiresAt: number;
    }>`SELECT connection,revoked,last_issued_expires_at::double precision AS "lastIssuedExpiresAt" FROM foundry_instance.provider_connections WHERE instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} ORDER BY id`;
    return yield* Effect.forEach(rows, (row) =>
      decode({
        ...(row.connection as object),
        revoked: row.revoked,
        lastIssuedExpiresAt: row.lastIssuedExpiresAt,
      }),
    );
  }, Effect.catchTags(failures));
  const drainAllocations = Effect.fn("ProviderConnections.drainAllocations")(function* (
    owner: Owner,
    id: string,
  ) {
    yield* sql`UPDATE foundry_instance.sandbox_allocations SET allocation=allocation || jsonb_build_object(
      'state',CASE
        WHEN allocation->>'state' IN ('draining','stopped','archiving','deleting') THEN allocation->>'state'
        WHEN allocation->>'state'='failed' AND allocation->>'failureFrom' IN ('draining','stopped','archiving','deleting') THEN allocation->>'failureFrom'
        ELSE 'draining' END,
      'generation',(allocation->>'generation')::integer + CASE
        WHEN allocation->>'state' IN ('draining','stopped','archiving','deleting') OR (allocation->>'state'='failed' AND allocation->>'failureFrom' IN ('draining','stopped','archiving','deleting')) THEN 0 ELSE 1 END,
      'deleteRequested',true,'failure',NULL,'failureFrom',NULL)
      WHERE instance_id=${owner.instanceId} AND operator_id=${owner.operatorId}
      AND allocation->'profile'->>'providerConnectionId'=${id} AND allocation->>'state'<>'deleted'`;
  });
  const set = Effect.fn("ProviderConnections.set")(function* (
    owner: Owner,
    raw: SetFoundryProviderConnection,
  ) {
    yield* checkOwner(owner);
    const input = yield* decodeSet(raw);
    const connection = input.connection;
    if (connection.generation !== (input.expectedGeneration ?? 0) + 1)
      return yield* new FoundryProviderConnectionError({ code: "invalid_input" });
    // Verifies the selected central login without ever storing its tokens in metadata.
    yield* auth.access(connection);
    return yield* withSandboxAllocationLock(
      Effect.gen(function* () {
        yield* sql`SELECT operator_id FROM foundry_instance.operator_binding WHERE operator_id=${owner.operatorId} FOR UPDATE`;
        const rows = yield* sql<{
          same: boolean;
          generation: number;
          revoked: boolean;
          lastIssuedExpiresAt: number;
        }>`SELECT connection=${sql.json(connection)} AS same,generation,revoked,last_issued_expires_at::double precision AS "lastIssuedExpiresAt" FROM foundry_instance.provider_connections WHERE id=${connection.id} AND instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} FOR UPDATE`;
        const existing = rows[0];
        if (existing?.same && !existing.revoked)
          return {
            ...connection,
            revoked: false,
            lastIssuedExpiresAt: existing.lastIssuedExpiresAt,
          };
        if ((existing?.generation ?? null) !== input.expectedGeneration)
          return yield* new FoundryProviderConnectionError({ code: "conflict" });
        const saved =
          yield* sql`INSERT INTO foundry_instance.provider_connections(id,instance_id,operator_id,generation,connection,revoked) VALUES(${connection.id},${owner.instanceId},${owner.operatorId},${connection.generation},${sql.json(connection)},false) ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,connection=EXCLUDED.connection,revoked=false WHERE provider_connections.instance_id=EXCLUDED.instance_id AND provider_connections.operator_id=EXCLUDED.operator_id RETURNING id`;
        if (!saved[0]) return yield* new FoundryProviderConnectionError({ code: "conflict" });
        if (existing) yield* drainAllocations(owner, connection.id);
        return {
          ...connection,
          revoked: false,
          lastIssuedExpiresAt: existing?.lastIssuedExpiresAt ?? 0,
        };
      }),
    ).pipe(Effect.provideService(InstanceDatabase.InstanceDatabase, sql));
  }, Effect.catchTags(failures));
  const connect = Effect.fn("ProviderConnections.connect")(function* (
    owner: Owner,
    raw: ConnectFoundryProviderConnection,
  ) {
    yield* checkOwner(owner);
    const input = yield* decodeConnect(raw);
    const { profileKey } = yield* auth.currentProfile(input.providerInstanceId);
    return yield* set(owner, {
      expectedGeneration: input.expectedGeneration,
      connection: {
        id: input.id,
        label: input.label,
        providerInstanceId: input.providerInstanceId,
        profileKey,
        generation: (input.expectedGeneration ?? 0) + 1,
        grants: [],
      },
    });
  }, Effect.catchTags(failures));
  const revoke = Effect.fn("ProviderConnections.revoke")(
    function* (owner: Owner, id: string) {
      yield* checkOwner(owner);
      return yield* withSandboxAllocationLock(
        Effect.gen(function* () {
          const rows = yield* sql<{
            lastIssuedExpiresAt: number;
          }>`UPDATE foundry_instance.provider_connections SET revoked=true WHERE id=${id} AND instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} RETURNING last_issued_expires_at::double precision AS "lastIssuedExpiresAt"`;
          if (!rows[0]) return yield* forbidden();
          yield* drainAllocations(owner, id);
          return rows[0];
        }),
      ).pipe(Effect.provideService(InstanceDatabase.InstanceDatabase, sql));
    },
    Effect.catchTags({
      SqlError: failures.SqlError,
      InstanceDatabaseError: failures.InstanceDatabaseError,
    }),
  );
  const authorizeAllocation = Effect.fn("ProviderConnections.authorizeAllocation")(function* (
    owner: Owner,
    input: AllocationGrant,
  ) {
    yield* checkOwner(owner);
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          connection: unknown;
          lastIssuedExpiresAt: number;
        }>`SELECT c.connection,
        c.last_issued_expires_at::double precision AS "lastIssuedExpiresAt"
        FROM foundry_instance.provider_connections c
        JOIN foundry_instance.devices d ON d.instance_id=c.instance_id AND d.operator_id=c.operator_id
        JOIN foundry_instance.sandbox_allocations a ON a.instance_id=c.instance_id AND a.operator_id=c.operator_id
        WHERE c.id=${input.connectionId} AND c.instance_id=${owner.instanceId} AND c.operator_id=${owner.operatorId}
        AND NOT c.revoked AND d.device_id=${input.device.deviceId} AND d.environment_id=${input.device.environmentId}
        AND d.generation=${input.device.generation} AND NOT d.revoked
        AND a.allocation_id=${input.allocationId} AND a.allocation->>'deviceId'=d.device_id::text
        AND a.allocation->>'environmentId'=d.environment_id
        AND a.allocation->'profile'->>'providerConnectionId'=c.id
        AND a.allocation->>'state' IN ('setup','ready') AND (a.allocation->>'expiresAt')::bigint>${now}
        AND COALESCE(a.allocation->'request'->'owner'->>'factoryId','')=${input.factoryId ?? ""}
        FOR UPDATE OF c,d,a`;
        const row = rows[0];
        if (!row || input.device.instanceId !== owner.instanceId || input.device.revoked)
          return yield* forbidden();
        const connection = yield* decode({
          ...(row.connection as object),
          revoked: false,
          lastIssuedExpiresAt: row.lastIssuedExpiresAt,
        });
        const grant: FoundryProviderGrant = {
          deviceId: input.device.deviceId,
          deviceGeneration: input.device.generation,
          allocationId: input.allocationId,
          factoryId: input.factoryId,
        };
        const matching = connection.grants.filter(
          (value) => value.allocationId === input.allocationId,
        );
        if (matching.length) {
          if (
            matching.length !== 1 ||
            matching[0]?.deviceId !== grant.deviceId ||
            matching[0]?.deviceGeneration !== grant.deviceGeneration ||
            matching[0]?.factoryId !== grant.factoryId
          )
            return yield* new FoundryProviderConnectionError({ code: "conflict" });
          return connection;
        }
        if (connection.grants.length >= 256)
          return yield* new FoundryProviderConnectionError({ code: "conflict" });
        const updated = { ...connection, grants: [...connection.grants, grant] };
        yield* sql`UPDATE foundry_instance.provider_connections SET connection=jsonb_set(connection,'{grants}',${sql.json(updated.grants)}) WHERE id=${input.connectionId}`;
        return updated;
      }),
    );
  }, Effect.catchTags(failures));
  const releaseAllocation = Effect.fn("ProviderConnections.releaseAllocation")(
    function* (
      owner: Owner,
      input: { readonly connectionId: string; readonly allocationId: string },
    ) {
      yield* checkOwner(owner);
      yield* sql`UPDATE foundry_instance.provider_connections SET connection=jsonb_set(connection,'{grants}',
      COALESCE((SELECT jsonb_agg(grant_value) FROM jsonb_array_elements(connection->'grants') grant_value
        WHERE grant_value->>'allocationId' IS DISTINCT FROM ${input.allocationId}),'[]'::jsonb))
      WHERE id=${input.connectionId} AND instance_id=${owner.instanceId} AND operator_id=${owner.operatorId}`;
    },
    Effect.catchTags({
      SqlError: failures.SqlError,
      InstanceDatabaseError: failures.InstanceDatabaseError,
    }),
  );
  const authorize = Effect.fn("ProviderConnections.authorize")(function* (input: Issue) {
    const rows = yield* sql<{
      connection: unknown;
      lastIssuedExpiresAt: number;
    }>`SELECT c.connection,c.last_issued_expires_at::double precision AS "lastIssuedExpiresAt" FROM foundry_instance.provider_connections c JOIN foundry_instance.devices d ON d.instance_id=c.instance_id AND d.operator_id=c.operator_id WHERE c.id=${input.connectionId} AND c.instance_id=${input.instanceId} AND c.operator_id=${input.operatorId} AND c.generation=${input.generation} AND NOT c.revoked AND d.device_id=${input.deviceId} AND d.generation=${input.deviceGeneration} AND NOT d.revoked FOR UPDATE OF c,d`;
    if (!rows[0]) return yield* forbidden();
    const connection = yield* decode({
      ...(rows[0].connection as object),
      revoked: false,
      lastIssuedExpiresAt: rows[0].lastIssuedExpiresAt,
    });
    if (
      !connection.grants.some(
        (grant) =>
          grant.deviceId === input.deviceId &&
          grant.deviceGeneration === input.deviceGeneration &&
          grant.allocationId === input.allocationId &&
          grant.factoryId === input.factoryId,
      )
    )
      return yield* forbidden();
    if (input.allocationId !== null) {
      const now = yield* Clock.currentTimeMillis;
      const allocations = yield* sql`SELECT 1 FROM foundry_instance.sandbox_allocations
        WHERE allocation_id=${input.allocationId} AND instance_id=${input.instanceId} AND operator_id=${input.operatorId}
        AND allocation->>'deviceId'=${input.deviceId} AND allocation->'profile'->>'providerConnectionId'=${input.connectionId}
        AND allocation->>'state' IN ('setup','ready') AND (allocation->>'expiresAt')::bigint>${now}
        AND COALESCE(allocation->'request'->'owner'->>'factoryId','')=${input.factoryId ?? ""} FOR UPDATE`;
      if (!allocations.length) return yield* forbidden();
    }
    return connection;
  });
  const issue = Effect.fn("ProviderConnections.issue")(function* (input: Issue) {
    yield* checkOwner(input);
    const connection = yield* sql.withTransaction(authorize(input));
    const issued = yield* auth.access(connection);
    if (issued.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new FoundryProviderConnectionError({ code: "login_required" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Recheck after upstream renewal so a concurrent revocation cannot issue a new token.
        yield* authorize(input);
        yield* sql`UPDATE foundry_instance.provider_connections SET last_issued_expires_at=GREATEST(last_issued_expires_at,${issued.expiresAt}) WHERE id=${input.connectionId}`;
        return issued;
      }),
    );
  }, Effect.catchTags(failures));
  return ProviderConnections.of({
    connect,
    list,
    set,
    revoke,
    issue,
    authorizeAllocation,
    releaseAllocation,
  });
});

export const layer = Layer.effect(ProviderConnections, make);
