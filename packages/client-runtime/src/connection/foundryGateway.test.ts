import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  FoundryInstanceId,
  FoundryDeviceId,
  FoundryGatewayGrantId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FoundryConnectionTarget, BearerConnectionTarget } from "./model.ts";
import * as FoundryGateway from "./foundryGateway.ts";
import { FoundryInstanceSession } from "./foundryMain.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import { connectionRoutes, mergeLearnedRoutes } from "./routes.ts";

const baseTarget = new FoundryConnectionTarget({
  environmentId: EnvironmentId.make("worker"),
  label: "Worker",
  binding: {
    origin: "https://main.example.test",
    issuer: "https://team.cloudflareaccess.com",
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    mainEnvironmentId: EnvironmentId.make("main"),
  },
  deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
  scopes: ["orchestration:read", "terminal:operate"],
});

it.effect.each([
  "ok",
  "loopback",
  "loopback-disabled",
  "insecure-other",
  "dpop",
  "bearer",
  "identity",
  "redirect",
  "html",
  "scope",
  "target",
  "expired",
  "session",
  "capability",
] as const)("prepares a pinned gateway connection and rejects %s", (mode) =>
  Effect.gen(function* () {
    const target = new FoundryConnectionTarget({
      ...baseTarget,
      binding: {
        ...baseTarget.binding,
        ...(mode === "loopback" || mode === "loopback-disabled"
          ? { origin: "http://localhost:15174", issuer: "http://localhost:15174" }
          : mode === "insecure-other"
            ? { origin: "http://main.example.test:15174" }
            : {}),
      },
      scopes: mode === "ok" ? [...baseTarget.scopes, "orchestration:operate"] : baseTarget.scopes,
    });
    const now = yield* Clock.currentTimeMillis;
    let grants = 0;
    let tickets = 0;
    let inspectFailure: "revoked" | "scope" | "target" | "expired" | undefined;
    const http = layerRemoteHttpClient((async (input, init) => {
      const path = new URL(String(input)).pathname;
      expect(new URL(String(input)).origin).toBe(target.binding.origin);
      expect(init?.redirect).toBe("manual");
      if (path === "/.well-known/foundry") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        if (mode === "redirect")
          return new Response(null, { status: 302, headers: { location: "https://foreign.test" } });
        if (mode === "html")
          return new Response("<html>Access</html>", { headers: { "content-type": "text/html" } });
        return Response.json({
          protocolVersion: "1",
          instanceId:
            mode === "identity"
              ? "33333333-3333-4333-8333-333333333333"
              : target.binding.instanceId,
          mainEnvironmentId: target.binding.mainEnvironmentId,
          capabilities: [
            "foundry.instance-descriptor",
            "foundry.access-sessions",
            ...(mode === "capability" ? [] : ["foundry.rpc-streams"]),
          ],
          negotiatedCapabilities: [],
          instanceAuth: {
            publicOrigin: target.binding.origin,
            issuer: target.binding.issuer,
            bootstrapMethods: [mode === "loopback" ? "password" : "cloudflare-access-jwt"],
            sessionMethods: ["foundry-session-cookie"],
          },
          auth: {
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
          },
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("x-foundry-csrf")).toBe("fixture-csrf");
      if (mode === "bearer") expect(headers.get("authorization")).toBe("Bearer fixture-token");
      if (mode === "dpop") {
        expect(headers.get("authorization")).toBe("DPoP fixture-token");
        expect(JSON.parse(headers.get("dpop") ?? "null")).toEqual({
          method: "POST",
          url: `${target.binding.origin}${path}`,
          accessToken: "fixture-token",
        });
      }
      if (path.endsWith("/create") || path.endsWith("/inspect")) {
        if (path.endsWith("/inspect") && inspectFailure === "revoked")
          return new Response(null, { status: 403 });
        if (path.endsWith("/create")) grants++;
        return Response.json({
          protocolVersion: "2",
          grantKind: "clientAccess",
          accessGeneration: 1,
          grantId: FoundryGatewayGrantId.make("44444444-4444-4444-8444-444444444444"),
          instanceId: target.binding.instanceId,
          origin: target.binding.origin,
          deviceId: target.deviceId,
          environmentId:
            mode === "target" || inspectFailure === "target" ? "other" : target.environmentId,
          scopes:
            mode === "scope" || inspectFailure === "scope" ? ["orchestration:read"] : target.scopes,
          operatorId: "operator",
          clientSessionId: AuthSessionId.make("client"),
          subject: "client",
          generation: 1,
          channelGeneration: 1,
          expiresAt: inspectFailure === "expired" ? now : now + 60000,
        });
      }
      tickets++;
      return Response.json({
        ticket: "a".repeat(43),
        wsTicket: `ticket-${tickets}`,
        expiresAt: mode === "expired" ? now : now + 10000,
      });
    }) satisfies typeof fetch);
    const gateway = yield* FoundryGateway.make({
      allowLoopback: mode === "loopback" || mode === "insecure-other",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          http,
          Layer.succeed(ManagedRelayDpopSigner, {
            thumbprint: Effect.succeed("fixture-key"),
            createProof: (input) => Effect.succeed(JSON.stringify(input)),
          }),
          Layer.succeed(FoundryInstanceSession, {
            current: () =>
              Effect.succeed({
                binding: {
                  ...target.binding,
                  origin: mode === "session" ? "https://other.test" : target.binding.origin,
                },
                csrfToken: "fixture-csrf",
                authorization:
                  mode === "dpop"
                    ? { _tag: "Dpop", accessToken: "fixture-token", expiresAtEpochMs: now + 60000 }
                    : mode === "bearer"
                      ? { _tag: "Bearer", token: "fixture-token" }
                      : null,
              }),
          }),
        ),
      ),
    );
    const first = yield* gateway.prepare(target).pipe(Effect.result);
    if (mode !== "ok" && mode !== "loopback" && mode !== "dpop" && mode !== "bearer") {
      expect(first._tag).toBe("Failure");
      expect(tickets).toBe(mode === "expired" ? 1 : 0);
      return;
    }
    if (first._tag !== "Success") return yield* Effect.die("prepare failed");
    const second = yield* gateway.prepare(target);
    expect(new URL(second.socketUrl).protocol).toBe(mode === "loopback" ? "ws:" : "wss:");
    expect(first.success.socketUrl).not.toEqual(second.socketUrl);
    expect(grants).toBe(2);
    expect(second.httpAuthorization).toBeNull();
    if (mode === "dpop")
      expect(JSON.parse(new URL(second.socketUrl).searchParams.get("dpop") ?? "null")).toEqual({
        method: "GET",
        url: `${target.binding.origin}/api/foundry/gateway/stream`,
        accessToken: "ticket-2",
      });
    expect(second.httpBaseUrl).toContain(`/api/foundry/gateway/devices/${target.deviceId}/`);
    const sessionInput = {
      prepared: second,
      signer: Option.none(),
      auth: {
        policy: "remote-reachable" as const,
        sessionCookieName: "t3_session",
        bootstrapMethods: ["one-time-token" as const],
        sessionMethods: ["dpop-access-token" as const],
        serverUpdateScope: "environment:maintain" as const,
      },
    };
    const permissions = yield* fetchEnvironmentSessionState(sessionInput).pipe(
      Effect.provide(http),
    );
    expect(permissions.authenticated).toBe(true);
    expect(permissions.permissions).toEqual(target.scopes);
    expect(permissions.permissions?.includes("orchestration:operate")).toBe(mode === "ok");
    expect(permissions.auth).toEqual(sessionInput.auth);
    for (const failure of ["revoked", "scope", "target", "expired"] as const) {
      inspectFailure = failure;
      expect(
        (yield* fetchEnvironmentSessionState(sessionInput).pipe(
          Effect.provide(http),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }
    expect(grants).toBe(2);
    const entry = {
      target,
      profile: Option.none(),
      enabled: true,
      alternateRoutes: [
        {
          target: new BearerConnectionTarget({
            environmentId: target.environmentId,
            label: "Bypass",
            connectionId: "direct",
          }),
          profile: Option.none(),
        },
      ],
    };
    expect(connectionRoutes(entry)).toHaveLength(1);
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: entry,
        reported: [{ httpBaseUrl: "https://worker-direct.test" }],
        allowInsecure: false,
      }),
    ).toBeNull();
  }),
);
