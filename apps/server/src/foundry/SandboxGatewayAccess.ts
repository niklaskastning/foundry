import {
  FoundryGatewayError,
  type FoundryInstanceId,
  type FoundryDeviceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as InstanceDatabase from "./InstanceDatabase.ts";

export interface SandboxGatewayTarget {
  readonly instanceId: FoundryInstanceId;
  readonly operatorId: string;
  readonly allocationId: string;
  readonly deviceId: FoundryDeviceId;
  readonly environmentId: EnvironmentId;
}
export class SandboxGatewayAccess extends Context.Reference<{
  readonly validateDevice: (
    target: Omit<SandboxGatewayTarget, "allocationId">,
  ) => Effect.Effect<void, FoundryGatewayError>;
  readonly validate: (
    target: SandboxGatewayTarget,
    probe: boolean,
  ) => Effect.Effect<number, FoundryGatewayError>;
}>("t3/foundry/SandboxGatewayAccess", {
  defaultValue: () => ({
    validateDevice: () => Effect.void,
    validate: () => Effect.fail(new FoundryGatewayError({ code: "forbidden" })),
  }),
}) {}

export const layer = Layer.effect(
  SandboxGatewayAccess,
  Effect.gen(function* () {
    const sql = yield* InstanceDatabase.InstanceDatabase;
    return {
      validateDevice: Effect.fn("SandboxGatewayAccess.validateDevice")(
        function* (target: Omit<SandboxGatewayTarget, "allocationId">) {
          const rows = yield* sql<{
            instanceId: string;
            operatorId: string;
            environmentId: string;
            state: string;
            expiresAt: number;
          }>`SELECT instance_id AS "instanceId",operator_id AS "operatorId",allocation->>'environmentId' AS "environmentId",allocation->>'state' AS state,(allocation->>'expiresAt')::double precision AS "expiresAt"
          FROM foundry_instance.sandbox_allocations WHERE allocation->>'deviceId'=${target.deviceId} LIMIT 2`;
          if (!rows.length) return;
          const row = rows[0]!;
          if (
            rows.length !== 1 ||
            row.instanceId !== target.instanceId ||
            row.operatorId !== target.operatorId ||
            row.environmentId !== target.environmentId ||
            row.state !== "ready" ||
            row.expiresAt <= (yield* Clock.currentTimeMillis)
          )
            return yield* new FoundryGatewayError({ code: "forbidden" });
        },
        Effect.catchTags({
          SqlError: () => Effect.fail(new FoundryGatewayError({ code: "unavailable" })),
        }),
      ),
      validate: Effect.fn("SandboxGatewayAccess.validate")(
        function* (target: SandboxGatewayTarget, probe: boolean) {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql<{
            expiresAt: number;
          }>`SELECT (allocation->>'expiresAt')::double precision AS "expiresAt"
        FROM foundry_instance.sandbox_allocations WHERE allocation_id=${target.allocationId}
        AND instance_id=${target.instanceId} AND operator_id=${target.operatorId}
        AND allocation->>'deviceId'=${target.deviceId} AND allocation->>'environmentId'=${target.environmentId}
        AND (allocation->>'expiresAt')::bigint>${now}
        AND (allocation->>'state'='ready' OR (${probe} AND allocation->>'state'='setup'))`;
          if (!rows[0]) return yield* new FoundryGatewayError({ code: "forbidden" });
          return rows[0].expiresAt;
        },
        Effect.catchTags({
          SqlError: () => Effect.fail(new FoundryGatewayError({ code: "unavailable" })),
        }),
      ),
    };
  }),
);
