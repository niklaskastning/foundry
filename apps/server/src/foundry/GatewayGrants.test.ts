// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signing real DPoP proofs exercises the existing HTTP authenticator.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryInstanceId,
  FoundryDeviceId,
  FoundryAuthError,
  FoundryDeviceError,
  type FoundryDevice,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DeviceChannel from "./DeviceChannel.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as FoundrySessions from "./FoundrySessions.ts";
import * as GatewayGrants from "./GatewayGrants.ts";
import * as GatewayHttp from "./gatewayHttp.ts";

const origin = "https://main.example.test";
const csrf = "a".repeat(43);
const fixture = Effect.gen(function* () {
  const device: FoundryDevice = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("worker"),
    publicKey: "a".repeat(43),
    generation: 1,
    revoked: false,
  };
  let channelGeneration = 1;
  let online = true;
  let revoked = false;
  let foundryActive = true;
  const expiresAt = (yield* Clock.currentTimeMillis) + 600_000;
  const dispatched = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    GatewayGrants.layer.pipe(
      Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin })),
      Layer.provide(
        Layer.succeed(FoundrySessions.FoundrySessions, {
          inspect: (token) =>
            (token === "foundry-fixture" || token === "foundry-fixture-other") && foundryActive
              ? Effect.succeed({
                  instanceId: device.instanceId,
                  operatorId: "operator",
                  expiresAt,
                  csrfToken: token === "foundry-fixture" ? csrf : "b".repeat(43),
                })
              : Effect.fail(new FoundryAuthError({ code: "invalid_session" })),
          checkOrigin: (value, contentType) =>
            value === origin && contentType === "application/json"
              ? Effect.void
              : Effect.fail(new FoundryAuthError({ code: "origin_forbidden" })),
          login: () => Effect.die("not used"),
          refresh: () => Effect.die("not used"),
          logout: () => Effect.die("not used"),
        }),
      ),
      Layer.provide(
        Layer.succeed(DeviceChannel.DeviceChannel, {
          serve: () => Effect.die("not used"),
          projects: (_, validate) =>
            Effect.gen(function* () {
              yield* validate;
              yield* Deferred.succeed(dispatched, undefined);
              yield* Deferred.await(finish);
              yield* validate;
              return { projects: [], updatedAt: "2026-11-01T00:00:00.000Z" };
            }),
          current: (id) =>
            online && id === device.deviceId && !revoked
              ? Effect.succeed({ device: { ...device, revoked }, channelGeneration })
              : Effect.fail(new FoundryDeviceError({ code: "unavailable" })),
        }),
      ),
      Layer.provideMerge(EnvironmentAuth.layer),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-gateway-test-" })),
      Layer.provide(NodeServices.layer),
    ),
  );
  const grants = Context.get(services, GatewayGrants.GatewayGrants);
  const sessions = Context.get(services, SessionStore.SessionStore);
  const request = (token: string, changes: Record<string, string> = {}, path = "create") =>
    HttpServerRequest.fromWeb(
      new Request(`${origin}/api/foundry/gateway/grants/${path}`, {
        method: "POST",
        headers: {
          origin,
          host: "main.example.test",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          "x-foundry-csrf": csrf,
          cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-fixture`,
          authorization: `Bearer ${token}`,
          ...changes,
        },
      }),
    );
  const target = { deviceId: device.deviceId, environmentId: device.environmentId };
  const input = { ...target, scopes: ["orchestration:read"] };
  const read = yield* sessions.issue({
    scopes: ["orchestration:read"],
    subject: "client",
    method: "bearer-access-token",
  });
  return {
    grants,
    dispatched,
    finish,
    sessions,
    request,
    read,
    input,
    target,
    disconnect: () => {
      online = false;
    },
    reconnect: () => {
      online = true;
      channelGeneration++;
    },
    logout: () => {
      foundryActive = false;
    },
    revoke: () => {
      revoked = true;
    },
  };
});

it.effect(
  "issues only explicit read grants and binds each use to the caller, target and live channel",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = f.request(f.read.token);
      const grant = yield* f.grants.create(request, f.input);
      expect(grant).toMatchObject({
        ...f.input,
        subject: "client",
        clientSessionId: f.read.sessionId,
        generation: 1,
        channelGeneration: 1,
      });
      const lookup = { ...f.target, grantId: grant.grantId };
      expect(yield* f.grants.inspect(request, lookup)).toEqual(grant);
      expect(
        (yield* f.grants
          .inspect(
            f.request(f.read.token, {
              cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-fixture-other`,
              "x-foundry-csrf": "b".repeat(43),
            }),
            lookup,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      for (const input of [
        { ...f.input, scopes: ["orchestration:operate"] },
        { ...f.input, scopes: ["orchestration:read", "orchestration:operate"] },
        { ...f.input, scopes: [] },
        { ...f.input, environmentId: "another-environment" },
      ])
        expect((yield* f.grants.create(request, input).pipe(Effect.result))._tag).toBe("Failure");
      for (const changes of [
        { origin: "https://other.test" },
        { host: "other.test" },
        { "x-forwarded-proto": "http" },
        { "x-foundry-csrf": "wrong" },
        { cookie: "" },
        { authorization: "" },
      ])
        expect(
          (yield* f.grants.create(f.request(f.read.token, changes), f.input).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      const other = yield* f.sessions.issue({
        scopes: ["orchestration:read"],
        subject: "client",
        method: "bearer-access-token",
      });
      expect(
        (yield* f.grants.inspect(f.request(other.token), lookup).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.grants.remove(f.request(other.token), lookup).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.grants
          .inspect(request, { ...lookup, environmentId: "wrong" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const denied = yield* f.sessions.issue({
        scopes: ["filesystem:read"],
        method: "bearer-access-token",
      });
      expect(
        (yield* f.grants.create(f.request(denied.token), f.input).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.grants.remove(request, lookup);
      expect((yield* f.grants.inspect(request, lookup).pipe(Effect.result))._tag).toBe("Failure");
      const next = yield* f.grants.create(request, f.input);
      f.reconnect();
      expect(
        (yield* f.grants.inspect(request, { ...lookup, grantId: next.grantId }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const active = yield* f.grants.create(request, f.input);
      f.revoke();
      expect(
        (yield* f.grants
          .inspect(request, { ...lookup, grantId: active.grantId })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.effect(
  "bounds storage and expiry, and rejects session revocation, logout and disconnected devices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = f.request(f.read.token);
      const grant = yield* f.grants.create(request, f.input);
      const lookup = { ...f.target, grantId: grant.grantId };
      for (let index = 1; index < 128; index++) yield* f.grants.create(request, f.input);
      expect(yield* f.grants.create(request, f.input).pipe(Effect.flip)).toMatchObject({
        code: "capacity",
      });
      yield* TestClock.adjust("60 seconds");
      expect((yield* f.grants.inspect(request, lookup).pipe(Effect.result))._tag).toBe("Failure");
      const fresh = yield* f.grants.create(request, f.input);
      yield* f.sessions.revoke(f.read.sessionId);
      expect(
        (yield* f.grants
          .inspect(request, { ...lookup, grantId: fresh.grantId })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const newSession = yield* f.sessions.issue({
        scopes: ["orchestration:read"],
        method: "bearer-access-token",
      });
      f.disconnect();
      expect(
        (yield* f.grants.create(f.request(newSession.token), f.input).pipe(Effect.result))._tag,
      ).toBe("Failure");
      f.reconnect();
      const active = yield* f.grants.create(f.request(newSession.token), f.input);
      f.logout();
      expect(
        (yield* f.grants
          .inspect(f.request(newSession.token), { ...lookup, grantId: active.grantId })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.effect(
  "terminates DPoP at the public URL and rejects replay, URL changes and bearer downgrade",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const session = yield* f.sessions.issue({
        scopes: ["orchestration:read"],
        method: "bearer-access-token",
        proofKeyThumbprint: computeDpopJwkThumbprint(jwk),
      });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk });
      const payload = encode({
        htm: "POST",
        htu: `${origin}/api/foundry/gateway/grants/create`,
        jti: "proof-1",
        iat: Math.floor((yield* Clock.currentTimeMillis) / 1000),
        ath: computeDpopAccessTokenHash(session.token),
      });
      const unsigned = `${header}.${payload}`;
      const proof = `${unsigned}.${NodeCrypto.sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      const headers = { authorization: `DPoP ${session.token}`, dpop: proof };
      expect(
        (yield* f.grants
          .create(f.request(session.token, headers, "inspect"), f.input)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.grants.create(f.request(session.token), f.input).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.grants.create(f.request(session.token, headers), f.input);
      expect(
        (yield* f.grants.create(f.request(session.token, headers), f.input).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.live("bounds HTTP bodies without Content-Length and returns no credential or cookie", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const handler = HttpRouter.toWebHandler(
      GatewayHttp.layer.pipe(
        Layer.provide(Layer.succeed(GatewayGrants.GatewayGrants, f.grants)),
        Layer.provide(Layer.succeed(DeviceConfig.HttpGatewayEnabled, true)),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()));
    const send = (body: string, path = "create") =>
      Effect.promise(() =>
        handler.handler(
          new Request(
            path === "projects"
              ? `${origin}/api/foundry/gateway/projects`
              : `${origin}/api/foundry/gateway/grants/${path}`,
            {
              method: "POST",
              headers: f.request(f.read.token).headers,
              body,
            },
          ),
        ),
      );
    const response = yield* send(JSON.stringify(f.input));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = yield* Effect.promise(() => response.text());
    expect(text).not.toContain(f.read.token);
    expect(text).not.toContain(csrf);
    for (const body of [
      "{}".repeat(3000),
      "<html>Access</html>",
      JSON.stringify({ ...f.input, scopes: ["orchestration:operate"] }),
    ])
      expect((yield* send(body)).status).toBe(400);
    const grant = yield* f.grants.create(f.request(f.read.token), f.input);
    yield* Deferred.succeed(f.finish, undefined);
    for (const extra of [
      { path: "/api/projects/../../auth/session" },
      { method: "POST" },
      { url: "https://other.test" },
    ]) {
      const response = yield* send(
        JSON.stringify({ ...f.target, grantId: grant.grantId, ...extra }),
        "projects",
      );
      expect(response.status).toBe(400);
    }
    expect(yield* Deferred.isDone(f.dispatched)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each(["success", "session-revoke", "grant-remove", "foundry-logout"] as const)(
  "revalidates authority before returning a device response: %s",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = f.request(f.read.token);
      const grant = yield* f.grants.create(request, f.input);
      const lookup = { ...f.target, grantId: grant.grantId };
      const read = yield* f.grants.projects(request, lookup).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(f.dispatched);
      if (action === "session-revoke") yield* f.sessions.revoke(f.read.sessionId);
      if (action === "grant-remove") yield* f.grants.remove(request, lookup);
      if (action === "foundry-logout") f.logout();
      yield* Deferred.succeed(f.finish, undefined);
      expect((yield* Fiber.join(read))._tag).toBe(action === "success" ? "Success" : "Failure");
    }).pipe(Effect.scoped),
);
