import {
  FoundryArchiveRequest,
  FoundryArchivePage,
  FoundryArchiveMachineRequest,
  FoundryArchiveError,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as ThreadArchive from "./ThreadArchive.ts";
import * as ClientIdentity from "./ClientIdentity.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import { verifyArchiveRequest } from "./ThreadArchiveProof.ts";

const decodeRequest = Schema.decodeUnknownEffect(FoundryArchiveRequest, {
  onExcessProperty: "error",
});
const decodeMachine = Schema.decodeUnknownEffect(FoundryArchiveMachineRequest, {
  onExcessProperty: "error",
});
const isArtifactError = Schema.is(FoundryArchiveError);
const operationError = (error: unknown) =>
  isArtifactError(error)
    ? error
    : Schema.isSchemaError(error)
      ? new FoundryArchiveError({ code: "invalid_request" })
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "unavailable" || error.code === "configuration")
        ? new FoundryArchiveError({ code: "unavailable" })
        : new FoundryArchiveError({ code: "forbidden" });

export class ThreadArchiveAccess extends Context.Service<
  ThreadArchiveAccess,
  {
    readonly client: (
      request: HttpServerRequest.HttpServerRequest,
      input: unknown,
    ) => Effect.Effect<unknown, FoundryArchiveError>;
    readonly machine: (input: unknown) => Effect.Effect<unknown, FoundryArchiveError>;
  }
>()("t3/foundry/ThreadArchiveAccess") {}
const make = Effect.gen(function* () {
  const store = yield* ThreadArchive.ThreadArchive;
  const registry = yield* DeviceRegistry.DeviceRegistry;
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const clientContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ClientIdentity.authenticate>>>();
  const dispatch = Effect.fn("ThreadArchiveAccess.dispatch")(function* (
    principal: ThreadArchive.FoundryArchivePrincipal,
    request: FoundryArchiveRequest,
  ) {
    switch (request.op) {
      case "ingest":
        return yield* store.ingest(principal, request.input);
      case "cursor":
        return yield* store.cursor(principal, request.input);
      case "read":
        return yield* store
          .read(principal, request.input)
          .pipe(Effect.flatMap(Schema.encodeEffect(FoundryArchivePage)));
      case "list":
        return yield* store.list(principal, request.input);
    }
  });
  return ThreadArchiveAccess.of({
    client: Effect.fn("ThreadArchiveAccess.client")(function* (request, raw) {
      const input = yield* decodeRequest(raw);
      if (input.op !== "list" && input.op !== "read")
        return yield* new FoundryArchiveError({ code: "forbidden" });
      const actor = yield* ClientIdentity.authenticate(request).pipe(Effect.provide(clientContext));
      if (!actor.client.scopes.includes(AuthOrchestrationReadScope))
        return yield* new FoundryArchiveError({ code: "forbidden" });
      return yield* dispatch(
        { instanceId: actor.foundry.instanceId, operatorId: actor.foundry.operatorId },
        input,
      );
    }, Effect.mapError(operationError)),
    machine: Effect.fn("ThreadArchiveAccess.machine")(function* (raw) {
      const input = yield* decodeMachine(raw);
      const now = yield* Clock.currentTimeMillis;
      const device = yield* registry.get(input.deviceId);
      if (
        (input.request.op !== "cursor" && input.request.op !== "ingest") ||
        device.revoked ||
        device.instanceId !== input.instanceId ||
        device.environmentId !== input.environmentId ||
        device.generation !== input.generation ||
        Math.abs(now - input.issuedAt) > 120_000 ||
        !verifyArchiveRequest(origin, input, device.publicKey)
      )
        return yield* new FoundryArchiveError({ code: "forbidden" });
      const operators = yield* sql<{
        operatorId: string;
      }>`SELECT operator_id AS "operatorId" FROM foundry_instance.devices WHERE device_id=${device.deviceId} AND instance_id=${device.instanceId} AND generation=${device.generation} AND NOT revoked`;
      if (!operators[0]) return yield* new FoundryArchiveError({ code: "forbidden" });
      return yield* dispatch(
        {
          instanceId: device.instanceId,
          operatorId: operators[0].operatorId,
          deviceEnvironmentId: device.environmentId,
          deviceId: device.deviceId,
          generation: device.generation,
        },
        input.request,
      );
    }, Effect.mapError(operationError)),
  });
});
export const layer = Layer.effect(ThreadArchiveAccess, make);
