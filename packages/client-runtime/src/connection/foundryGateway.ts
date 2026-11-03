import {
  authScopeResponse,
  type ServerAuthDescriptor,
  type AuthSessionState,
  FoundryGatewayGrant,
  FoundryGatewaySocketTicket,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { verifyDescriptor } from "./foundry.ts";
import * as FoundryMain from "./foundryMain.ts";
import {
  ConnectionBlockedError,
  type FoundryConnectionTarget,
  type PreparedConnection,
} from "./model.ts";

const decodeGrant = Schema.decodeUnknownEffect(FoundryGatewayGrant);
const decodeTicket = Schema.decodeUnknownEffect(FoundryGatewaySocketTicket);
const blocked = () =>
  new ConnectionBlockedError({
    reason: "authentication",
    detail:
      "Foundry gateway access was rejected. Verify Foundry sign-in and the T3 session permissions on Main.",
  });
export const make = Effect.fn("FoundryGateway.make")(function* () {
  const main = yield* FoundryMain.make();
  const prepare = Effect.fn("FoundryGateway.prepare")(function* (target: FoundryConnectionTarget) {
    const { request, origin, session, proof } = yield* main.prepare(target.binding);
    const value = yield* request("/.well-known/foundry?protocolVersion=1");
    const verified = yield* Effect.try({
      try: () => verifyDescriptor(value, origin, target.binding),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "The Foundry instance identity, origin or issuer changed. Connection blocked.",
        }),
    });
    if (!verified.descriptor.capabilities.includes("foundry.rpc-streams"))
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "This Foundry instance does not support RPC streams.",
      });
    const grant = yield* request("/api/foundry/gateway/grants/create", {
      deviceId: target.deviceId,
      environmentId: target.environmentId,
      scopes: target.scopes,
    }).pipe(
      Effect.flatMap(decodeGrant),
      Effect.mapError((error) => (Schema.isSchemaError(error) ? blocked() : error)),
    );
    if (
      grant.instanceId !== target.binding.instanceId ||
      grant.origin !== origin ||
      grant.deviceId !== target.deviceId ||
      grant.environmentId !== target.environmentId ||
      grant.scopes.length !== target.scopes.length ||
      !grant.scopes.every((scope) => target.scopes.includes(scope)) ||
      grant.expiresAt <= (yield* Clock.currentTimeMillis)
    )
      return yield* blocked();
    const issued = yield* request("/api/foundry/gateway/grants/ticket", {
      grantId: grant.grantId,
      deviceId: target.deviceId,
      environmentId: target.environmentId,
    }).pipe(
      Effect.flatMap(decodeTicket),
      Effect.mapError((error) => (Schema.isSchemaError(error) ? blocked() : error)),
    );
    if (issued.expiresAt <= (yield* Clock.currentTimeMillis) || issued.expiresAt > grant.expiresAt)
      return yield* blocked();
    const url = new URL(`${origin}/api/foundry/gateway/stream`);
    url.searchParams.set("ticket", issued.ticket);
    url.searchParams.set("wsTicket", issued.wsTicket);
    if (session.authorization?._tag === "Dpop")
      url.searchParams.set(
        "dpop",
        yield* proof(`${origin}/api/foundry/gateway/stream`, issued.wsTicket, "GET"),
      );
    url.protocol = "wss:";
    const readSessionState = Effect.fn("FoundryGateway.readSessionState")(function* (
      auth: ServerAuthDescriptor,
    ) {
      const current = yield* request("/api/foundry/gateway/grants/inspect", {
        grantId: grant.grantId,
        deviceId: target.deviceId,
        environmentId: target.environmentId,
      }).pipe(Effect.flatMap(decodeGrant), Effect.mapError(blocked));
      const fields = [
        "grantId",
        "instanceId",
        "origin",
        "deviceId",
        "environmentId",
        "clientSessionId",
        "operatorId",
        "subject",
        "generation",
        "channelGeneration",
        "accessGeneration",
        "expiresAt",
      ] as const;
      if (
        fields.some((field) => current[field] !== grant[field]) ||
        current.scopes.length !== grant.scopes.length ||
        !current.scopes.every((scope) => grant.scopes.includes(scope)) ||
        current.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return yield* blocked();
      return {
        authenticated: true,
        auth,
        ...authScopeResponse(current.scopes),
        sessionMethod: "dpop-access-token",
        expiresAt: DateTime.makeUnsafe(current.expiresAt),
      } satisfies AuthSessionState;
    });
    return {
      readSessionState,
      target,
      environmentId: target.environmentId,
      label: target.label,
      socketUrl: url.href,
      httpBaseUrl: `${origin}/api/foundry/gateway/devices/${target.deviceId}/`,
      httpAuthorization: null,
    } satisfies PreparedConnection;
  });
  return { prepare };
});
