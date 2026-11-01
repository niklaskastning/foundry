import { it, expect } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryDeviceError,
  FoundryInstanceId,
  type FoundryDevice,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServer } from "effect/http";
import * as DeviceChannel from "./DeviceChannel.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as ChannelHttp from "./deviceChannelHttp.ts";
import * as DeviceConnector from "./DeviceConnector.ts";
import { openFrames } from "./DeviceChannelProtocol.ts";
import { generateDeviceKey, signChannel } from "./DeviceProof.ts";

const fixture = Effect.gen(function* () {
  const key = generateDeviceKey();
  const device: FoundryDevice = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("worker"),
    publicKey: key.publicKey,
    generation: 1,
    revoked: false,
  };
  let channelGeneration = 0;
  let revoked = false;
  const checked = yield* Deferred.make<void>();
  const origin = "https://main.example.test";
  const registry = DeviceRegistry.DeviceRegistry.of({
    approve: () => Effect.die("not used"),
    enroll: () => Effect.die("not used"),
    get: () => Effect.sync(() => ({ ...device, revoked })),
    revoke: () =>
      Effect.sync(() => {
        revoked = true;
      }),
    claimChannel: () => Effect.sync(() => ++channelGeneration),
    checkChannel: (_, generation) =>
      Effect.gen(function* () {
        if (revoked) return yield* new FoundryDeviceError({ code: "revoked" });
        if (generation !== channelGeneration)
          return yield* new FoundryDeviceError({ code: "channel_superseded" });
        yield* Deferred.succeed(checked, undefined);
      }),
  });
  const channelLayer = DeviceChannel.layer.pipe(
    Layer.provide(Layer.succeed(DeviceRegistry.DeviceRegistry, registry)),
    Layer.provide(
      Layer.succeed(InstancePostgres.InstancePostgres, {
        readIdentity: Effect.succeed(device.instanceId),
      }),
    ),
    Layer.provide(Layer.succeed(DeviceConfig.DeviceOrigin, { origin })),
    Layer.provide(NodeServices.layer),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(ChannelHttp.layer, { disableListenLog: true }).pipe(
      Layer.provideMerge(channelLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const channels = Context.get(services, DeviceChannel.DeviceChannel);
  const url =
    HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address).replace(
      /^http/,
      "ws",
    ) + "/api/foundry/devices/channel";
  const socket = Socket.makeWebSocket(url).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
  );
  return { socket, url, device, key, registry, origin, checked, channels };
});

it.live(
  "authenticates real sockets, rejects replay, fences the previous channel and observes revocation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* f.channels.current(f.device.deviceId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      const first = yield* openFrames(yield* f.socket);
      const challenge = yield* first.read;
      expect(challenge.type).toBe("challenge");
      if (challenge.type !== "challenge") return;
      const hello = signChannel(challenge, f.device, f.key.privateKey);
      yield* first.send(hello);
      const ready = yield* first.read;
      expect(ready.type).toBe("ready");
      if (ready.type !== "ready") return;
      yield* first.send({ type: "heartbeat", connectionId: ready.connectionId, sequence: 1 });
      expect(yield* first.read).toEqual({
        type: "ack",
        connectionId: ready.connectionId,
        sequence: 1,
      });
      const replay = yield* openFrames(yield* f.socket);
      const replayChallenge = yield* replay.read;
      expect(replayChallenge).not.toEqual(challenge);
      yield* replay.send(hello);
      expect(yield* replay.read).toEqual({ type: "error", code: "invalid_proof" });
      const second = yield* openFrames(yield* f.socket);
      const next = yield* second.read;
      if (next.type !== "challenge") return yield* Effect.die("challenge missing");
      yield* second.send(signChannel(next, f.device, f.key.privateKey));
      const current = yield* second.read;
      if (current.type !== "ready") return yield* Effect.die("ready missing");
      expect(current.channelGeneration).toBeGreaterThan(ready.channelGeneration);
      expect((yield* f.channels.current(f.device.deviceId)).channelGeneration).toBe(
        current.channelGeneration,
      );
      yield* first.send({ type: "heartbeat", connectionId: ready.connectionId, sequence: 2 });
      expect(yield* first.read).toEqual({ type: "error", code: "channel_superseded" });
      expect((yield* f.channels.current(f.device.deviceId)).channelGeneration).toBe(
        current.channelGeneration,
      );
      yield* f.registry.revoke(f.device.deviceId);
      expect((yield* f.channels.current(f.device.deviceId).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* second.send({ type: "heartbeat", connectionId: current.connectionId, sequence: 1 });
      expect(yield* second.read).toEqual({ type: "error", code: "revoked" });
    }).pipe(Effect.scoped),
);

it.effect.each(["handshake", "heartbeat"] as const)(
  "closes a channel with no %s at its deadline",
  (stage) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const io = yield* openFrames(yield* f.socket);
      const challenge = yield* io.read;
      if (challenge.type !== "challenge") return yield* Effect.die("challenge missing");
      if (stage === "heartbeat") {
        yield* io.send(signChannel(challenge, f.device, f.key.privateKey));
        expect((yield* io.read).type).toBe("ready");
      }
      yield* TestClock.adjust(stage === "handshake" ? "10 seconds" : "30 seconds");
      expect(yield* io.read).toEqual({ type: "error", code: "unavailable" });
    }).pipe(Effect.scoped),
);

it.effect(
  "redials after transport loss and authenticates a fresh channel before resuming heartbeats",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let current: NodeSocket.NodeWS.WebSocket | undefined;
      const socket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(() => {
            const ws = new NodeSocket.NodeWS.WebSocket(f.url);
            ws.on("error", () => undefined);
            current = ws;
            return ws;
          }),
          (ws) => Effect.sync(() => ws.terminate()),
        ),
      );
      const connections = yield* Queue.unbounded<void>();
      const fiber = yield* DeviceConnector.run(socket, {
        origin: f.origin,
        device: f.device,
        privateKey: Redacted.make(f.key.privateKey),
        localEnvironmentId: Effect.succeed(f.device.environmentId),
        connected: Queue.offer(connections, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.forkScoped);
      yield* Queue.take(connections);
      yield* Deferred.await(f.checked);
      const first = current;
      if (!first) return yield* Effect.die("socket missing");
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            first.once("close", () => resolve());
            first.terminate();
          }),
      );
      yield* TestClock.adjust("1 second");
      yield* Queue.take(connections);
      expect(current).not.toBe(first);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
);

it.effect("refuses an Access credential bound to another origin before dialing", () =>
  Effect.gen(function* () {
    const result = yield* DeviceConnector.makeSocket("https://other.example.test", {
      origin: "https://main.example.test",
      clientId: Redacted.make("fixture-id"),
      clientSecret: Redacted.make("fixture-secret"),
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "configuration" } });
  }),
);

it.live.each(["environment", "generation", "signature"] as const)(
  "rejects a foreign channel %s",
  (field) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const io = yield* openFrames(yield* f.socket);
      const challenge = yield* io.read;
      if (challenge.type !== "challenge") return yield* Effect.die("challenge missing");
      const hello = signChannel(
        challenge,
        {
          ...f.device,
          ...(field === "environment" ? { environmentId: EnvironmentId.make("other") } : {}),
          ...(field === "generation" ? { generation: 2 } : {}),
        },
        f.key.privateKey,
      );
      yield* io.send(field === "signature" ? { ...hello, signature: "A".repeat(86) } : hello);
      expect(yield* io.read).toEqual({ type: "error", code: "invalid_proof" });
    }).pipe(Effect.scoped),
);

it.live("runs the actual connector handshake and heartbeat without starting a local server", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const connected = yield* Deferred.make<void>();
    const fiber = yield* DeviceConnector.runOnce(yield* f.socket, {
      origin: f.origin,
      device: f.device,
      privateKey: Redacted.make(f.key.privateKey),
      localEnvironmentId: Effect.succeed(f.device.environmentId),
      connected: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    yield* Deferred.await(f.checked);
    yield* Fiber.interrupt(fiber);
    const mismatch = yield* DeviceConnector.runOnce(yield* f.socket, {
      origin: f.origin,
      device: f.device,
      privateKey: Redacted.make(f.key.privateKey),
      localEnvironmentId: Effect.succeed(EnvironmentId.make("other")),
      connected: Effect.die("must not connect"),
    }).pipe(Effect.result);
    expect(mismatch).toMatchObject({ _tag: "Failure", failure: { code: "configuration" } });
  }).pipe(Effect.scoped),
);
