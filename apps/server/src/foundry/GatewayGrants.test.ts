// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signing real DPoP proofs exercises the existing HTTP authenticator.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  EnvironmentId,
  FoundryInstanceId,
  FoundryDeviceId,
  FoundryAuthError,
  FoundryDeviceError,
  FoundryGatewayError,
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
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DeviceGrants from "./DeviceGrants.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import { bridge } from "./StreamBridge.ts";
import * as Queue from "effect/Queue";
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
  let accessGeneration = 1;
  let accessEnabled = true;
  let databaseHangs = false;
  let stream: DeviceChannel.DeviceChannel["Service"]["stream"] = () => Effect.void;
  const expiresAt = (yield* Clock.currentTimeMillis) + 600_000;
  const dispatched = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    GatewayGrants.layer.pipe(
      Layer.provide(
        Layer.succeed(DeviceRegistry.DeviceRegistry, {
          list: (operatorId) =>
            Effect.succeed(
              operatorId === "operator"
                ? [
                    {
                      deviceId: device.deviceId,
                      environmentId: device.environmentId,
                      revoked,
                      clientAccess: {
                        enabled: accessEnabled && !revoked,
                        generation: accessGeneration,
                      },
                    },
                  ]
                : [],
            ),
          approve: () => Effect.die("not used"),
          enroll: () => Effect.die("not used"),
          get: () => Effect.succeed(device),
          revoke: () =>
            Effect.sync(() => {
              revoked = true;
            }),
          claimChannel: () => Effect.die("not used"),
          checkChannel: () => Effect.die("not used"),
        }),
      ),
      Layer.provide(
        Layer.succeed(DeviceGrants.DeviceGrants, {
          read: () =>
            Effect.succeed(
              ["clientAccess", "automationExecution", "sandboxProvisioning"].map((kind) => ({
                deviceId: device.deviceId,
                kind: kind as "clientAccess" | "automationExecution" | "sandboxProvisioning",
                generation: accessGeneration,
                enabled: kind === "clientAccess" && accessEnabled,
              })),
            ),
          update: () => Effect.die("not used"),
          check: (_id, _operator, generation) =>
            Effect.suspend(() =>
              databaseHangs
                ? Effect.never
                : accessEnabled && (generation === undefined || generation === accessGeneration)
                  ? Effect.succeed(accessGeneration)
                  : Effect.fail(new FoundryGatewayError({ code: "forbidden" })),
            ),
        }),
      ),
      Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin })),
      Layer.provide(Layer.succeed(DeviceConfig.StreamGatewayEnabled, true)),
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
          stream: (...args) => stream(...args),
          attachStream: () => Effect.die("not used"),
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
              ? Effect.succeed({
                  device: { ...device, revoked },
                  channelGeneration,
                  rpcStream: true,
                })
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
    setStream: (value: typeof stream) => {
      stream = value;
    },
    setAccess: (enabled: boolean) => {
      accessEnabled = enabled;
      accessGeneration++;
    },
    hangDatabase: () => {
      databaseHangs = true;
    },
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
      const catalog = yield* f.grants.catalog(request, {});
      expect(catalog).toMatchObject({
        canManage: false,
        devices: [{ online: true, rpcReady: true, clientAccess: { enabled: true } }],
      });
      expect(catalog.devices[0]).not.toHaveProperty("publicKey");
      const second = yield* f.sessions.issue({
        scopes: ["orchestration:read"],
        subject: "second-client",
        method: "bearer-access-token",
      });
      expect(
        yield* f.grants.catalog(
          f.request(second.token, {
            cookie: `${FoundrySessions.FOUNDRY_SESSION_COOKIE}=foundry-fixture-other`,
            "x-foundry-csrf": "b".repeat(43),
          }),
          {},
        ),
      ).toEqual(catalog);
      expect(
        (yield* f.grants
          .catalog(f.request(f.read.token, { "x-foundry-csrf": "wrong" }), {})
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.grants.approveDevice(request, {}).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.grants.revokeDevice(request, f.target).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      f.disconnect();
      expect((yield* f.grants.catalog(request, {})).devices).toMatchObject([
        { online: false, rpcReady: false },
      ]);
      f.reconnect();
      const grant = yield* f.grants.create(request, f.input);
      expect(grant).toMatchObject({
        ...f.input,
        subject: "client",
        clientSessionId: f.read.sessionId,
        generation: 1,
        channelGeneration: 2,
      });
      expect(
        (yield* f.grants.readAccess(request, { deviceId: f.target.deviceId }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect((yield* f.grants.updateAccess(request, {}).pipe(Effect.result))._tag).toBe("Failure");
      const manager = yield* f.sessions.issue({
        scopes: ["access:write"],
        subject: "operator",
        method: "bearer-access-token",
      });
      expect(
        yield* f.grants.readAccess(f.request(manager.token), { deviceId: f.target.deviceId }),
      ).toHaveLength(3);
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
      expect(
        (yield* f.grants
          .revokeDevice(f.request(manager.token), {
            deviceId: FoundryDeviceId.make("44444444-4444-4444-8444-444444444444"),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.grants.revokeDevice(f.request(manager.token), { deviceId: f.target.deviceId });
      expect((yield* f.grants.catalog(request, {})).devices).toMatchObject([
        { revoked: true, online: false, clientAccess: { enabled: false } },
      ]);
      expect((yield* f.grants.catalog(f.request(second.token), {})).devices).toMatchObject([
        { revoked: true, clientAccess: { enabled: false } },
      ]);

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
      JSON.stringify({ ...f.input, scopes: ["access:write"] }),
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

it.effect("binds single-use stream tickets to live sessions, scopes, origin and expiry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const session = yield* f.sessions.issue({
      scopes: ["orchestration:read", "terminal:operate", "filesystem:read"],
      method: "bearer-access-token",
    });
    const request = f.request(session.token);
    const grant = yield* f.grants.create(request, {
      ...f.input,
      scopes: ["orchestration:read", "terminal:operate", "filesystem:read"],
    });
    const withoutFileAccess = yield* f.sessions.issue({
      scopes: ["orchestration:read", "terminal:operate"],
      method: "bearer-access-token",
    });
    expect(
      (yield* f.grants
        .create(f.request(withoutFileAccess.token), {
          ...f.input,
          scopes: ["orchestration:read", "filesystem:read"],
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const lookup = { ...f.target, grantId: grant.grantId };
    const upgrade = Effect.succeed(
      Socket.make({ reader: Effect.die("unused"), writer: Effect.die("unused") }),
    );
    const socketRequest = (
      ticket: { ticket: string; wsTicket: string },
      headers = request.headers,
      protocol = ORCHESTRATION_PROTOCOL_VERSION,
    ) =>
      HttpServerRequest.fromWeb(
        new Request(
          `${origin}/api/foundry/gateway/stream?orchestrationProtocol=${protocol}&ticket=${ticket.ticket}&wsTicket=${ticket.wsTicket}`,
          { headers },
        ),
      );
    const incompatible = yield* f.grants.ticket(request, lookup);
    expect(
      (yield* f.grants
        .stream(
          socketRequest(incompatible, request.headers, ORCHESTRATION_PROTOCOL_VERSION + 1),
          Effect.die("no incompatible upgrade"),
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const first = yield* f.grants.ticket(request, lookup);
    yield* f.grants.stream(socketRequest(first), upgrade);
    expect(
      (yield* f.grants
        .stream(socketRequest(first), Effect.die("no replay upgrade"))
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const wrongOrigin = yield* f.grants.ticket(request, lookup);
    expect(
      (yield* f.grants
        .stream(
          socketRequest(wrongOrigin, { ...request.headers, origin: "https://foreign.test" }),
          Effect.die("no foreign upgrade"),
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const expired = yield* f.grants.ticket(request, lookup);
    yield* TestClock.adjust("10 seconds");
    expect(
      (yield* f.grants
        .stream(socketRequest(expired), Effect.die("no expired upgrade"))
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const removed = yield* f.grants.ticket(request, lookup);
    yield* f.grants.remove(request, lookup);
    expect(
      (yield* f.grants
        .stream(socketRequest(removed), Effect.die("no removed grant upgrade"))
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* f.grants
        .create(f.request(f.read.token), {
          ...f.input,
          scopes: ["orchestration:read", "terminal:operate", "filesystem:read"],
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.effect("keeps the client's DPoP binding on the Main stream ticket", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
    const session = yield* f.sessions.issue({
      scopes: ["orchestration:read"],
      method: "dpop-access-token",
      proofKeyThumbprint: computeDpopJwkThumbprint(jwk),
    });
    const now = yield* Clock.currentTimeMillis;
    const proof = (path: string, token: string, method = "POST") => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk })}.${encode({ htm: method, htu: `${origin}${path}`, jti: NodeCrypto.randomUUID(), iat: Math.floor(now / 1000), ath: computeDpopAccessTokenHash(token) })}`;
      return `${unsigned}.${NodeCrypto.sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    const request = (operation: string) =>
      f.request(
        session.token,
        {
          authorization: `DPoP ${session.token}`,
          dpop: proof(`/api/foundry/gateway/grants/${operation}`, session.token),
        },
        operation,
      );
    const grant = yield* f.grants.create(request("create"), f.input);
    const lookup = { ...f.target, grantId: grant.grantId };
    const missing = yield* f.grants.ticket(request("ticket"), lookup);
    const get = (ticket: typeof missing, dpop?: string) =>
      HttpServerRequest.fromWeb(
        new Request(
          `${origin}/api/foundry/gateway/stream?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&ticket=${ticket.ticket}&wsTicket=${ticket.wsTicket}${dpop ? `&dpop=${dpop}` : ""}`,
          { headers: { origin, host: "main.example.test", "x-forwarded-proto": "https" } },
        ),
      );
    expect(
      (yield* f.grants.stream(get(missing), Effect.die("proof required")).pipe(Effect.result))._tag,
    ).toBe("Failure");
    const valid = yield* f.grants.ticket(request("ticket"), lookup);
    yield* f.grants.stream(
      get(valid, proof("/api/foundry/gateway/stream", valid.wsTicket, "GET")),
      Effect.succeed(Socket.make({ reader: Effect.die("unused"), writer: Effect.die("unused") })),
    );
  }).pipe(Effect.scoped),
);

it.effect("bounds concurrently issued stream tickets and reclaims expired slots", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const request = f.request(f.read.token);
    const grant = yield* f.grants.create(request, f.input);
    const lookup = { ...f.target, grantId: grant.grantId };
    const results = yield* Effect.all(
      Array.from({ length: 129 }, () => f.grants.ticket(request, lookup).pipe(Effect.result)),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(128);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
    yield* TestClock.adjust("10 seconds");
    yield* f.grants.ticket(request, lookup);
  }).pipe(Effect.scoped),
);

it.effect.each(["grant-remove", "device-access", "database-hang"] as const)(
  "closes active streams after %s and never revives old access generations",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request = f.request(f.read.token);
      const grant = yield* f.grants.create(request, f.input);
      const other = yield* f.grants.create(request, f.input);
      const lookup = { ...f.target, grantId: grant.grantId };
      const ticket = yield* f.grants.ticket(request, lookup);
      const closed = yield* Queue.unbounded<void>();
      const started = yield* Deferred.make<void>();
      const socket = () =>
        Socket.make({
          reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
          writer: Effect.succeed({
            write: () => Queue.offer(closed, undefined).pipe(Effect.asVoid),
            writeAll: () => Effect.void,
          }),
        });
      f.setStream((_, validate, client) =>
        bridge(
          client,
          socket(),
          validate.pipe(Effect.tap(() => Deferred.succeed(started, undefined))),
        ),
      );
      const get = HttpServerRequest.fromWeb(
        new Request(
          `${origin}/api/foundry/gateway/stream?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&ticket=${ticket.ticket}&wsTicket=${ticket.wsTicket}`,
          { headers: { origin, host: "main.example.test", "x-forwarded-proto": "https" } },
        ),
      );
      const fiber = yield* f.grants
        .stream(get, Effect.succeed(socket()))
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      if (action === "grant-remove") yield* f.grants.remove(request, lookup);
      else if (action === "device-access") f.setAccess(false);
      else f.hangDatabase();
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
      yield* Queue.take(closed);
      yield* Queue.take(closed);
      if (action === "database-hang") return;
      if (action === "device-access") {
        expect((yield* f.grants.create(request, f.input).pipe(Effect.result))._tag).toBe("Failure");
        f.setAccess(true);
        const renewed = yield* f.grants.create(request, f.input);
        expect(renewed.accessGeneration).toBeGreaterThan(grant.accessGeneration);
      } else {
        expect(
          (yield* f.grants.inspect(request, { ...f.target, grantId: other.grantId })).grantId,
        ).toBe(other.grantId);
      }
      expect((yield* f.grants.inspect(request, lookup).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.scoped),
);
