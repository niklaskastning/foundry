import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundryGatewayGrantId,
  EnvironmentAuthenticatedPrincipal,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type FoundryDevice,
  type FoundryGatewayGrant,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DeviceHttpAdapter from "./DeviceHttpAdapter.ts";

const fixture = Effect.gen(function* () {
  const services = yield* Layer.build(
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-device-http-" })),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(NodeServices.layer),
    ),
  );
  const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
  const sessions = Context.get(services, SessionStore.SessionStore);
  const environmentId = yield* Context.get(services, ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const device: FoundryDevice = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId,
    publicKey: "a".repeat(43),
    generation: 1,
    revoked: false,
  };
  const origin = "https://main.example.test";
  const grant: FoundryGatewayGrant = {
    grantId: FoundryGatewayGrantId.make("33333333-3333-4333-8333-333333333333"),
    protocolVersion: "1",
    deviceId: device.deviceId,
    instanceId: device.instanceId,
    environmentId,
    origin,
    operatorId: "operator",
    subject: "client",
    clientSessionId: AuthSessionId.make("client-session"),
    generation: 1,
    channelGeneration: 1,
    scopes: ["orchestration:read"],
    expiresAt: (yield* Clock.currentTimeMillis) + 60000,
  };
  const requests = yield* Queue.unbounded<HttpServerRequest.HttpServerRequest>();
  const snapshot = { projects: [], updatedAt: "2026-11-01T00:00:00.000Z" };
  let mode: "ok" | "redirect" | "html" | "oversize" | "wrong-environment" | "hang" = "ok";
  let targetHits = 0;
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/t3/environment",
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({
          environmentId: mode === "wrong-environment" ? "other" : environmentId,
          label: "isolated worker",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "test",
          capabilities: {},
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/projects",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request);
        const principal = { ...session, scopes: new Set(session.scopes) };
        yield* requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
        );
        expect(session.scopes).toEqual(["orchestration:read"]);
        expect(
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
            Effect.result,
          ),
        ).toMatchObject({ _tag: "Failure" });
        expect(session.subject).toContain('"kind":"foundry-gateway-v1"');
        expect(session.subject).toContain(grant.grantId);
        expect(session.subject).toContain(grant.operatorId);
        expect(request.headers.cookie).toBeUndefined();
        yield* Queue.offer(requests, request);
        if (mode === "hang") return yield* Effect.never;
        if (mode === "redirect")
          return HttpServerResponse.empty({
            status: 302,
            headers: { location: "/redirect-target" },
          });
        if (mode === "html") return HttpServerResponse.html("<html>Access login</html>");
        if (mode === "oversize")
          return HttpServerResponse.text("x".repeat(65537), {
            headers: { "content-type": "application/json" },
          });
        return HttpServerResponse.jsonUnsafe(snapshot, {
          headers: { "set-cookie": "private-device-cookie=never-forward" },
        });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 }))),
    ),
    HttpRouter.add(
      "GET",
      "/redirect-target",
      Effect.sync(() => {
        targetHits++;
        return HttpServerResponse.jsonUnsafe(snapshot);
      }),
    ),
  );
  const server = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const address = new URL(
    HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address),
  );
  address.hostname = "127.0.0.1";
  const localOrigin = address.origin;
  const options = {
    device,
    origin,
    localOrigin,
    localEnvironmentId: Effect.succeed(environmentId),
  };
  const adapter = yield* DeviceHttpAdapter.make(options).pipe(Effect.provide(services));
  return {
    adapter,
    grant,
    requests,
    sessions,
    auth,
    options,
    services,
    snapshot,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    targetHits: () => targetHits,
  };
});

it.live(
  "uses a scoped local DPoP session with actor provenance and revokes it after the read",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* f.adapter.projects(f.grant, 1)).toEqual(f.snapshot);
      const request = yield* Queue.take(f.requests);
      expect(request.url).toBe("/api/projects");
      const token = request.headers.authorization!.slice("DPoP ".length);
      expect((yield* f.sessions.verify(token).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.auth.authenticateHttpRequest(request).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped),
);

it.live(
  "refuses changed bindings, mutation scopes and arbitrary proxy origins before dispatch",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const change of [
        { environmentId: "wrong" },
        { deviceId: "44444444-4444-4444-8444-444444444444" },
        { instanceId: "44444444-4444-4444-8444-444444444444" },
        { origin: "https://other.test" },
        { generation: 2 },
        { channelGeneration: 2 },
        { expiresAt: 0 },
        { scopes: ["orchestration:operate"] },
      ])
        expect(
          (yield* f.adapter.projects({ ...f.grant, ...change }, 1).pipe(Effect.result))._tag,
        ).toBe("Failure");
      for (const localOrigin of [
        "http://example.test",
        "http://127.0.0.1/api/../projects",
        "http://127.0.0.1/?target=other",
        "http://user@127.0.0.1",
        "file:///etc/passwd",
      ])
        expect(
          (yield* DeviceHttpAdapter.make({ ...f.options, localOrigin }).pipe(
            Effect.provide(f.services),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      f.setMode("wrong-environment");
      expect((yield* f.adapter.projects(f.grant, 1).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* Queue.size(f.requests)).toBe(0);
    }).pipe(Effect.scoped),
);

it.live(
  "does not follow redirects or return HTML/oversized bodies and revokes failed request sessions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const mode of ["redirect", "html", "oversize"] as const) {
        f.setMode(mode);
        expect((yield* f.adapter.projects(f.grant, 1).pipe(Effect.result))._tag).toBe("Failure");
        const request = yield* Queue.take(f.requests);
        expect(
          (yield* f.sessions
            .verify(request.headers.authorization!.slice("DPoP ".length))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(f.targetHits()).toBe(0);
    }).pipe(Effect.scoped),
);

it.live("revokes the local session when a pending HTTP request is cancelled", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setMode("hang");
    const read = yield* f.adapter.projects(f.grant, 1).pipe(Effect.forkScoped);
    const request = yield* Queue.take(f.requests);
    yield* Fiber.interrupt(read);
    expect(
      (yield* f.sessions
        .verify(request.headers.authorization!.slice("DPoP ".length))
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped),
);
