import { FoundryGatewayGrant, FoundryGatewaySocketTicket } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { normalizeOrigin, verifyDescriptor, type InstanceBinding } from "./foundry.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type FoundryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "./model.ts";

export class FoundryInstanceSession extends Context.Reference<{
  readonly current: (binding: InstanceBinding) => Effect.Effect<
    {
      readonly binding: InstanceBinding;
      readonly csrfToken: string;
      readonly authorization: PreparedHttpAuthorization | null;
    },
    ConnectionAttemptError
  >;
}>("clientRuntime/FoundryInstanceSession", {
  defaultValue: () => ({
    current: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "authentication",
          detail: "Verify and sign in to this Foundry instance before connecting to a device.",
        }),
      ),
  }),
}) {}

const decodeGrant = Schema.decodeUnknownEffect(FoundryGatewayGrant);
const decodeTicket = Schema.decodeUnknownEffect(FoundryGatewaySocketTicket);
const blocked = () =>
  new ConnectionBlockedError({
    reason: "authentication",
    detail:
      "Foundry gateway access was rejected. Verify Foundry sign-in and the T3 session permissions on Main.",
  });
const unavailable = () =>
  new ConnectionTransientError({
    reason: "transport",
    detail:
      "The Foundry gateway could not be reached. Retry after checking the instance connection.",
  });

export const make = Effect.fn("FoundryGateway.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const access = yield* FoundryInstanceSession;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const prepare = Effect.fn("FoundryGateway.prepare")(function* (target: FoundryConnectionTarget) {
    const origin = yield* Effect.try({
      try: () => normalizeOrigin(target.binding.origin),
      catch: blocked,
    });
    const session = yield* access.current(target.binding);
    if (
      session.binding.origin !== origin ||
      session.binding.instanceId !== target.binding.instanceId ||
      session.binding.issuer !== target.binding.issuer ||
      session.binding.mainEnvironmentId !== target.binding.mainEnvironmentId
    )
      return yield* blocked();
    const proof = (url: string, token: string, method: "GET" | "POST") =>
      Option.isSome(signer)
        ? signer.value
            .createProof({ method, url, accessToken: token })
            .pipe(Effect.mapError(blocked))
        : Effect.fail(blocked());
    const request = Effect.fn("FoundryGateway.request")(
      function* (path: string, body?: unknown) {
        const url = `${origin}${path}`;
        let req = HttpClientRequest.make(body === undefined ? "GET" : "POST")(url).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            ...(body === undefined ? {} : { "x-foundry-csrf": session.csrfToken }),
          }),
        );
        if (body !== undefined)
          req = yield* HttpClientRequest.bodyJson(req, body).pipe(Effect.mapError(blocked));
        if (body !== undefined && session.authorization?._tag === "Bearer")
          req = req.pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${session.authorization.token}`),
          );
        if (body !== undefined && session.authorization?._tag === "Dpop")
          req = req.pipe(
            HttpClientRequest.setHeaders({
              authorization: `DPoP ${session.authorization.accessToken}`,
              dpop: yield* proof(
                url,
                session.authorization.accessToken,
                body === undefined ? "GET" : "POST",
              ),
            }),
          );
        const response = yield* http.execute(req).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "include",
            cache: "no-store",
          }),
          Effect.mapError(unavailable),
        );
        if (
          (response.status >= 300 && response.status < 400) ||
          response.headers["content-type"]?.includes("text/html")
        )
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail:
              "Foundry returned an Access login page or redirect. Complete sign-in at the confirmed instance origin, then retry.",
          });
        if (response.status === 401 || response.status === 403) return yield* blocked();
        if (
          response.status !== 200 ||
          !response.headers["content-type"]?.includes("application/json")
        )
          return yield* unavailable();
        return yield* response.json.pipe(Effect.mapError(unavailable));
      },
      Effect.timeout("15 seconds"),
      Effect.catchTags({ TimeoutError: unavailable }),
    );
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
    return {
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
