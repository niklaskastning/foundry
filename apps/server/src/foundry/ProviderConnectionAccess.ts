import {
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  FoundryProviderConnectionError,
  FoundryProviderConnectionRequest,
  FoundryProviderMachineRequest,
  type FoundryProviderConnection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as ClientIdentity from "./ClientIdentity.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as ProviderConnections from "./ProviderConnections.ts";
import { verifyProviderRequest } from "./ProviderConnectionProof.ts";

const summary = ({
  id,
  label,
  providerInstanceId,
  generation,
  revoked,
  lastIssuedExpiresAt,
}: FoundryProviderConnection) => ({
  id,
  label,
  providerInstanceId,
  generation,
  revoked,
  lastIssuedExpiresAt,
});
const decodeClient = Schema.decodeUnknownEffect(FoundryProviderConnectionRequest, {
  onExcessProperty: "error",
});
const decodeMachine = Schema.decodeUnknownEffect(FoundryProviderMachineRequest, {
  onExcessProperty: "error",
});
const isError = Schema.is(FoundryProviderConnectionError);
const mapError = (error: unknown) =>
  isError(error) ? error : new FoundryProviderConnectionError({ code: "forbidden" });

export class ProviderConnectionAccess extends Context.Service<
  ProviderConnectionAccess,
  {
    readonly client: (
      request: HttpServerRequest.HttpServerRequest,
      input: unknown,
    ) => Effect.Effect<unknown, FoundryProviderConnectionError>;
    readonly machine: (
      input: unknown,
    ) => Effect.Effect<{ accessToken: string; expiresAt: number }, FoundryProviderConnectionError>;
  }
>()("t3/foundry/ProviderConnectionAccess") {}

const make = Effect.gen(function* () {
  const service = yield* ProviderConnections.ProviderConnections;
  const registry = yield* DeviceRegistry.DeviceRegistry;
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const authContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ClientIdentity.authenticate>>>();
  const client = Effect.fn("ProviderConnectionAccess.client")(function* (
    request: HttpServerRequest.HttpServerRequest,
    raw: unknown,
  ) {
    const input = yield* decodeClient(raw);
    const actor = yield* ClientIdentity.authenticate(request).pipe(
      Effect.provideContext(authContext),
    );
    if (
      !actor.client.scopes.includes(
        input.op === "list" ? AuthOrchestrationReadScope : AuthSettingsWriteScope,
      )
    )
      return yield* new FoundryProviderConnectionError({ code: "forbidden" });
    const owner = { instanceId: actor.foundry.instanceId, operatorId: actor.foundry.operatorId };
    switch (input.op) {
      case "list":
        return { connections: (yield* service.list(owner)).map(summary) };
      case "connect":
        return { connection: summary(yield* service.connect(owner, input.input)) };
      case "set":
        return yield* service.set(owner, input.input);
      case "revoke":
        return yield* service.revoke(owner, input.id);
    }
  }, Effect.mapError(mapError));
  const machine = Effect.fn("ProviderConnectionAccess.machine")(function* (raw: unknown) {
    const input = yield* decodeMachine(raw);
    const device = yield* registry.get(input.deviceId);
    if (
      device.revoked ||
      device.instanceId !== input.instanceId ||
      device.environmentId !== input.environmentId ||
      device.generation !== input.generation ||
      Math.abs((yield* Clock.currentTimeMillis) - input.issuedAt) > 120_000 ||
      !verifyProviderRequest(origin, input, device.publicKey)
    )
      return yield* new FoundryProviderConnectionError({ code: "forbidden" });
    const rows = yield* sql<{
      operatorId: string;
    }>`SELECT operator_id AS "operatorId" FROM foundry_instance.devices WHERE device_id=${device.deviceId} AND instance_id=${device.instanceId} AND generation=${device.generation} AND NOT revoked`;
    if (!rows[0]) return yield* new FoundryProviderConnectionError({ code: "forbidden" });
    const issued = yield* service.issue({
      instanceId: device.instanceId,
      operatorId: rows[0].operatorId,
      deviceId: device.deviceId,
      deviceGeneration: device.generation,
      connectionId: input.request.connectionId,
      generation: input.request.connectionGeneration,
      allocationId: input.request.allocationId,
      factoryId: input.request.factoryId,
    });
    return { accessToken: Redacted.value(issued.accessToken), expiresAt: issued.expiresAt };
  }, Effect.mapError(mapError));
  return ProviderConnectionAccess.of({ client, machine });
});
export const layer = Layer.effect(ProviderConnectionAccess, make);
