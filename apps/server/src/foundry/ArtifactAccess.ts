import {
  FoundryArtifactRequest,
  FoundryArtifactMachineRequest,
  FoundryArtifactError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Artifacts from "./Artifacts.ts";
import * as ClientIdentity from "./ClientIdentity.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import { verifyArtifactRequest } from "./ArtifactProof.ts";

const decodeRequest = Schema.decodeUnknownEffect(FoundryArtifactRequest, {
  onExcessProperty: "error",
});
const decodeMachine = Schema.decodeUnknownEffect(FoundryArtifactMachineRequest, {
  onExcessProperty: "error",
});
const isArtifactError = Schema.is(FoundryArtifactError);
const operationError = (error: unknown) =>
  isArtifactError(error)
    ? error
    : Schema.isSchemaError(error)
      ? new FoundryArtifactError({ code: "invalid_request" })
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "unavailable" || error.code === "configuration")
        ? new FoundryArtifactError({ code: "unavailable" })
        : new FoundryArtifactError({ code: "forbidden" });
const mutates = (request: FoundryArtifactRequest) =>
  ["begin", "write", "publish", "abort"].includes(request.op);
export class ArtifactAccess extends Context.Service<
  ArtifactAccess,
  {
    readonly client: (
      request: HttpServerRequest.HttpServerRequest,
      input: unknown,
    ) => Effect.Effect<unknown, FoundryArtifactError>;
    readonly machine: (input: unknown) => Effect.Effect<unknown, FoundryArtifactError>;
  }
>()("t3/foundry/ArtifactAccess") {}
const make = Effect.gen(function* () {
  const store = yield* Artifacts.Artifacts;
  const registry = yield* DeviceRegistry.DeviceRegistry;
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const clientContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ClientIdentity.authenticate>>>();
  const dispatch = Effect.fn("ArtifactAccess.dispatch")(function* (
    principal: Artifacts.ArtifactPrincipal,
    request: FoundryArtifactRequest,
  ) {
    switch (request.op) {
      case "begin":
        return yield* store.begin(principal, request.input);
      case "write":
        return yield* store.write(principal, request.input);
      case "read":
        return yield* store.read(principal, request.input);
      case "list":
        return yield* store.list(principal, request.input);
      case "status":
        return yield* store.status(principal, request.input);
      case "metadata":
        return yield* store.metadata(principal, request.input);
      case "publish":
        return yield* store.publish(principal, request.input);
      case "abort":
        return yield* store.abort(principal, request.input);
    }
  });
  return ArtifactAccess.of({
    client: Effect.fn("ArtifactAccess.client")(function* (request, raw) {
      const input = yield* decodeRequest(raw);
      const actor = yield* ClientIdentity.authenticate(request).pipe(Effect.provide(clientContext));
      if (
        !actor.client.scopes.includes(
          mutates(input) ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
        )
      )
        return yield* new FoundryArtifactError({ code: "forbidden" });
      return yield* dispatch(
        { instanceId: actor.foundry.instanceId, operatorId: actor.foundry.operatorId },
        input,
      );
    }, Effect.mapError(operationError)),
    machine: Effect.fn("ArtifactAccess.machine")(function* (raw) {
      const input = yield* decodeMachine(raw);
      const now = yield* Clock.currentTimeMillis;
      const device = yield* registry.get(input.deviceId);
      if (
        input.request.op === "list" ||
        device.revoked ||
        device.instanceId !== input.instanceId ||
        device.environmentId !== input.environmentId ||
        device.generation !== input.generation ||
        Math.abs(now - input.issuedAt) > 120_000 ||
        !verifyArtifactRequest(origin, input, device.publicKey)
      )
        return yield* new FoundryArtifactError({ code: "forbidden" });
      const operators = yield* sql<{
        operatorId: string;
      }>`SELECT operator_id AS "operatorId" FROM foundry_instance.devices WHERE device_id=${device.deviceId} AND instance_id=${device.instanceId} AND generation=${device.generation} AND NOT revoked`;
      if (!operators[0]) return yield* new FoundryArtifactError({ code: "forbidden" });
      return yield* dispatch(
        {
          instanceId: device.instanceId,
          operatorId: operators[0].operatorId,
          deviceEnvironmentId: device.environmentId,
        },
        input.request,
      );
    }, Effect.mapError(operationError)),
  });
});
export const layer = Layer.effect(ArtifactAccess, make);
