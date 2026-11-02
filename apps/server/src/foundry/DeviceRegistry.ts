import {
  EnvironmentId,
  FoundryDevice,
  FoundryDeviceId,
  FoundryDevicePublicKey,
  FoundryDeviceError,
  FoundryEnrollmentRequest,
  type FoundryEnrollment,
  type FoundryCatalogDevice,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { base64UrlEncode } from "../auth/utils.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import { verifyEnrollmentProof } from "./DeviceProof.ts";

const Approval = Schema.Struct({ environmentId: EnvironmentId, publicKey: FoundryDevicePublicKey });
const decodeApproval = Schema.decodeUnknownEffect(Approval);
const decodeRequest = Schema.decodeUnknownEffect(FoundryEnrollmentRequest);
const decodeDevice = Schema.decodeUnknownEffect(FoundryDevice);
type DeviceRow = {
  device_id: string;
  instance_id: string;
  environment_id: string;
  public_key: string;
  generation: number;
  revoked: boolean;
};
const fromRow = (row: DeviceRow) =>
  decodeDevice({
    deviceId: row.device_id,
    instanceId: row.instance_id,
    environmentId: row.environment_id,
    publicKey: row.public_key,
    generation: row.generation,
    revoked: row.revoked,
  });

export class DeviceRegistry extends Context.Service<
  DeviceRegistry,
  {
    readonly list: (
      operatorId: string,
    ) => Effect.Effect<
      ReadonlyArray<Omit<FoundryCatalogDevice, "online" | "rpcReady">>,
      FoundryDeviceError
    >;
    readonly approve: (
      input: typeof Approval.Type,
    ) => Effect.Effect<FoundryEnrollment, FoundryDeviceError>;
    readonly enroll: (
      input: FoundryEnrollmentRequest,
    ) => Effect.Effect<FoundryDevice, FoundryDeviceError>;
    readonly get: (deviceId: FoundryDeviceId) => Effect.Effect<FoundryDevice, FoundryDeviceError>;
    readonly revoke: (deviceId: FoundryDeviceId) => Effect.Effect<void, FoundryDeviceError>;
    readonly claimChannel: (device: FoundryDevice) => Effect.Effect<number, FoundryDeviceError>;
    readonly checkChannel: (
      device: FoundryDevice,
      channelGeneration: number,
    ) => Effect.Effect<void, FoundryDeviceError>;
  }
>()("t3/foundry/DeviceRegistry") {}

const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const crypto = yield* Crypto.Crypto;
  const failures = {
    InstanceDatabaseError: () => Effect.fail(new FoundryDeviceError({ code: "unavailable" })),
    SqlError: () => Effect.fail(new FoundryDeviceError({ code: "unavailable" })),
    SchemaError: () => Effect.fail(new FoundryDeviceError({ code: "invalid_enrollment" })),
  };
  const hash = Effect.fn("DeviceRegistry.hash")(function* (token: string) {
    return base64UrlEncode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.orDie),
    );
  });
  const get = Effect.fn("DeviceRegistry.get")(function* (deviceId: FoundryDeviceId) {
    const instanceId = yield* identity.readIdentity;
    const rows =
      yield* sql<DeviceRow>`SELECT * FROM foundry_instance.devices WHERE device_id = ${deviceId} AND instance_id = ${instanceId}`;
    if (!rows[0]) return yield* new FoundryDeviceError({ code: "not_found" });
    return yield* fromRow(rows[0]);
  }, Effect.catchTags(failures));
  const list = Effect.fn("DeviceRegistry.list")(function* (operatorId: string) {
    const instanceId = yield* identity.readIdentity;
    const rows = yield* sql<DeviceRow & { enabled: boolean; access_generation: number }>`
      SELECT d.*, g.enabled, g.generation AS access_generation
      FROM foundry_instance.devices d
      JOIN foundry_instance.device_grants g ON g.device_id = d.device_id AND g.kind = 'clientAccess'
      WHERE d.instance_id = ${instanceId} AND d.operator_id = ${operatorId}
      ORDER BY d.device_id LIMIT 129`;
    if (rows.length > 128) return yield* new FoundryDeviceError({ code: "unavailable" });
    return yield* Effect.forEach(rows, (row) =>
      fromRow(row).pipe(
        Effect.map((device) => ({
          deviceId: device.deviceId,
          environmentId: device.environmentId,
          revoked: device.revoked,
          clientAccess: {
            enabled: row.enabled && !device.revoked,
            generation: row.access_generation,
          },
        })),
      ),
    );
  }, Effect.catchTags(failures));
  const approve = Effect.fn("DeviceRegistry.approve")(function* (input: typeof Approval.Type) {
    const value = yield* decodeApproval(input);
    const instanceId = yield* identity.readIdentity;
    const operators = yield* sql<{
      operator_id: string;
      main_environment_id: string;
    }>`SELECT operator_id, main_environment_id FROM foundry_instance.operator_binding CROSS JOIN foundry_instance.instance`;
    if (!operators[0] || operators[0].main_environment_id === value.environmentId)
      return yield* new FoundryDeviceError({ code: "configuration" });
    const token = base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const deviceId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60 * 1000;
    const digest = yield* hash(token);
    yield* sql`INSERT INTO foundry_instance.device_enrollments (token_hash, device_id, instance_id, operator_id, origin, environment_id, public_key, expires_at)
      VALUES (${digest}, ${deviceId}, ${instanceId}, ${operators[0].operator_id}, ${origin}, ${value.environmentId}, ${value.publicKey}, ${expiresAt})`;
    return { protocolVersion: "1" as const, instanceId, origin, ...value, token, expiresAt };
  }, Effect.catchTags(failures));
  const enroll = Effect.fn("DeviceRegistry.enroll")(function* (input: FoundryEnrollmentRequest) {
    const value = yield* decodeRequest(input);
    const instanceId = yield* identity.readIdentity;
    const { enrollment } = value;
    if (enrollment.instanceId !== instanceId || enrollment.origin !== origin)
      return yield* new FoundryDeviceError({ code: "invalid_enrollment" });
    if (!verifyEnrollmentProof(value))
      return yield* new FoundryDeviceError({ code: "invalid_proof" });
    const digest = yield* hash(enrollment.token);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          device_id: string;
          instance_id: string;
          operator_id: string;
          origin: string;
          environment_id: string;
          public_key: string;
          expires_at: string;
          consumed: boolean;
        }>`SELECT * FROM foundry_instance.device_enrollments WHERE token_hash = ${digest} FOR UPDATE`;
        const row = rows[0];
        if (
          !row ||
          row.instance_id !== instanceId ||
          row.origin !== origin ||
          row.environment_id !== enrollment.environmentId ||
          row.public_key !== enrollment.publicKey ||
          Number(row.expires_at) !== enrollment.expiresAt
        )
          return yield* new FoundryDeviceError({ code: "invalid_enrollment" });
        if (Number(row.expires_at) <= (yield* Clock.currentTimeMillis))
          return yield* new FoundryDeviceError({ code: "expired_enrollment" });
        if (!row.consumed) {
          const inserted =
            yield* sql`INSERT INTO foundry_instance.devices (device_id, instance_id, operator_id, environment_id, public_key)
          VALUES (${row.device_id}, ${instanceId}, ${row.operator_id}, ${row.environment_id}, ${row.public_key}) ON CONFLICT DO NOTHING RETURNING device_id`;
          if (inserted.length !== 1) return yield* new FoundryDeviceError({ code: "conflict" });
          yield* sql`INSERT INTO foundry_instance.device_grants (device_id, kind, enabled)
            SELECT ${row.device_id}, kind, kind = 'clientAccess'
            FROM (VALUES ('clientAccess'), ('automationExecution'), ('sandboxProvisioning')) AS kinds(kind)`;
          yield* sql`UPDATE foundry_instance.device_enrollments SET consumed = true WHERE token_hash = ${digest}`;
        }
        const devices =
          yield* sql<DeviceRow>`SELECT * FROM foundry_instance.devices WHERE device_id = ${row.device_id} FOR UPDATE`;
        if (!devices[0]) return yield* new FoundryDeviceError({ code: "unavailable" });
        if (devices[0].revoked) return yield* new FoundryDeviceError({ code: "revoked" });
        return yield* fromRow(devices[0]);
      }),
    );
  }, Effect.catchTags(failures));
  const revoke = Effect.fn("DeviceRegistry.revoke")(
    function* (deviceId: FoundryDeviceId) {
      const instanceId = yield* identity.readIdentity;
      const rows =
        yield* sql`UPDATE foundry_instance.devices SET revoked = true, generation = generation + CASE WHEN revoked THEN 0 ELSE 1 END WHERE device_id = ${deviceId} AND instance_id = ${instanceId} RETURNING device_id`;
      if (!rows.length) return yield* new FoundryDeviceError({ code: "not_found" });
    },
    Effect.catchTags({
      InstanceDatabaseError: failures.InstanceDatabaseError,
      SqlError: failures.SqlError,
    }),
  );
  const claimChannel = Effect.fn("DeviceRegistry.claimChannel")(
    function* (device: FoundryDevice) {
      const instanceId = yield* identity.readIdentity;
      const rows = yield* sql<{
        channel_generation: number;
      }>`UPDATE foundry_instance.devices SET channel_generation = channel_generation + 1
      WHERE device_id = ${device.deviceId} AND instance_id = ${instanceId} AND generation = ${device.generation} AND NOT revoked RETURNING channel_generation`;
      if (!rows[0]) return yield* new FoundryDeviceError({ code: "revoked" });
      return rows[0].channel_generation;
    },
    Effect.catchTags({
      InstanceDatabaseError: failures.InstanceDatabaseError,
      SqlError: failures.SqlError,
    }),
  );
  const checkChannel = Effect.fn("DeviceRegistry.checkChannel")(
    function* (device: FoundryDevice, channelGeneration: number) {
      const instanceId = yield* identity.readIdentity;
      const rows = yield* sql<{
        generation: number;
        channel_generation: number;
        revoked: boolean;
      }>`SELECT generation, channel_generation, revoked FROM foundry_instance.devices WHERE device_id = ${device.deviceId} AND instance_id = ${instanceId}`;
      if (!rows[0] || rows[0].revoked || rows[0].generation !== device.generation)
        return yield* new FoundryDeviceError({ code: "revoked" });
      if (rows[0].channel_generation !== channelGeneration)
        return yield* new FoundryDeviceError({ code: "channel_superseded" });
    },
    Effect.catchTags({
      InstanceDatabaseError: failures.InstanceDatabaseError,
      SqlError: failures.SqlError,
    }),
  );
  return DeviceRegistry.of({ list, approve, enroll, get, revoke, claimChannel, checkChannel });
});
export const layer = Layer.effect(DeviceRegistry, make);
