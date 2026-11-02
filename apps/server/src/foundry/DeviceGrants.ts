import {
  FoundryDeviceGrant,
  FoundryDeviceGrantUpdate,
  FoundryDeviceId,
  FoundryGatewayError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";

const decodeUpdate = Schema.decodeUnknownEffect(FoundryDeviceGrantUpdate, {
  onExcessProperty: "error",
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(FoundryDeviceGrant));
const forbidden = () => new FoundryGatewayError({ code: "forbidden" });
const unavailable = () => new FoundryGatewayError({ code: "unavailable" });
export class DeviceGrants extends Context.Service<
  DeviceGrants,
  {
    readonly read: (
      deviceId: FoundryDeviceId,
      operatorId: string,
    ) => Effect.Effect<ReadonlyArray<FoundryDeviceGrant>, FoundryGatewayError>;
    readonly update: (
      input: unknown,
      operatorId: string,
    ) => Effect.Effect<FoundryDeviceGrant, FoundryGatewayError>;
    readonly check: (
      deviceId: FoundryDeviceId,
      operatorId: string,
      generation?: number,
    ) => Effect.Effect<number, FoundryGatewayError>;
  }
>()("t3/foundry/DeviceGrants") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const failure = () => Effect.fail(unavailable());
  const failures = {
    SqlError: failure,
    InstanceDatabaseError: failure,
    TimeoutError: failure,
    SchemaError: failure,
  };
  const read = Effect.fn("DeviceGrants.read")(
    function* (deviceId: FoundryDeviceId, operatorId: string) {
      const instanceId = yield* identity.readIdentity;
      const rows = yield* sql`SELECT g.device_id AS "deviceId", g.kind, g.enabled, g.generation
      FROM foundry_instance.device_grants g JOIN foundry_instance.devices d USING (device_id)
      WHERE d.device_id = ${deviceId} AND d.instance_id = ${instanceId} AND d.operator_id = ${operatorId} AND NOT d.revoked`;
      if (rows.length !== 3) return yield* forbidden();
      return yield* decodeRows(rows);
    },
    Effect.timeout("2 seconds"),
    Effect.catchTags(failures),
  );
  const check = Effect.fn("DeviceGrants.check")(function* (
    deviceId: FoundryDeviceId,
    operatorId: string,
    generation?: number,
  ) {
    const rows = yield* read(deviceId, operatorId);
    const grant = rows.find((row) => row.kind === "clientAccess");
    if (!grant?.enabled || (generation !== undefined && grant.generation !== generation))
      return yield* forbidden();
    return grant.generation;
  });
  const update = Effect.fn("DeviceGrants.update")(
    function* (input: unknown, operatorId: string) {
      const value = yield* decodeUpdate(input).pipe(
        Effect.mapError(() => new FoundryGatewayError({ code: "invalid_request" })),
      );
      if (value.kind !== "clientAccess") return yield* forbidden();
      const instanceId = yield* identity.readIdentity;
      const rows =
        yield* sql`UPDATE foundry_instance.device_grants g SET enabled = ${value.enabled}, generation = g.generation + 1
      FROM foundry_instance.devices d WHERE g.device_id = d.device_id AND d.device_id = ${value.deviceId}
      AND d.instance_id = ${instanceId} AND d.operator_id = ${operatorId} AND NOT d.revoked
      AND g.kind = ${value.kind} AND g.generation = ${value.generation}
      RETURNING g.device_id AS "deviceId", g.kind, g.enabled, g.generation`;
      if (rows.length !== 1) return yield* forbidden();
      return (yield* decodeRows(rows))[0]!;
    },
    Effect.timeout("2 seconds"),
    Effect.catchTags(failures),
  );
  return DeviceGrants.of({ read, update, check });
});
export const layer = Layer.effect(DeviceGrants, make);
