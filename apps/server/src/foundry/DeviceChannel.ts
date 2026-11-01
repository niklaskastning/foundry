import {
  FoundryDeviceError,
  FoundryGatewayError,
  type FoundryGatewayGrant,
  type ProjectSnapshot,
  type FoundryDeviceChannelFrame,
  type FoundryDeviceChallenge,
  type FoundryDevice,
  type FoundryDeviceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { base64UrlEncode } from "../auth/utils.ts";
import * as DeviceRegistry from "./DeviceRegistry.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import { verifyChannel } from "./DeviceProof.ts";
import { openFrames } from "./DeviceChannelProtocol.ts";

const isDeviceError = Schema.is(FoundryDeviceError);
const isGatewayError = Schema.is(FoundryGatewayError);

export class DeviceChannel extends Context.Service<
  DeviceChannel,
  {
    readonly projects: (
      grant: FoundryGatewayGrant,
      validate: Effect.Effect<void, FoundryGatewayError>,
    ) => Effect.Effect<ProjectSnapshot, FoundryGatewayError>;
    readonly serve: (socket: Socket.Socket) => Effect.Effect<void>;
    readonly current: (deviceId: FoundryDeviceId) => Effect.Effect<
      {
        readonly device: FoundryDevice;
        readonly channelGeneration: number;
      },
      FoundryDeviceError
    >;
  }
>()("t3/foundry/DeviceChannel") {}

const make = Effect.gen(function* () {
  const registry = yield* DeviceRegistry.DeviceRegistry;
  const identity = yield* InstancePostgres.InstancePostgres;
  const { origin } = yield* DeviceConfig.DeviceOrigin;
  const crypto = yield* Crypto.Crypto;
  type Pending = {
    grant: FoundryGatewayGrant;
    requestId: string;
    validate: Effect.Effect<void, FoundryGatewayError>;
    reply: Deferred.Deferred<ProjectSnapshot, FoundryGatewayError>;
    started: boolean;
  };
  type Lease = {
    device: FoundryDevice;
    channelGeneration: number;
    connectionId: string;
    httpRead: boolean;
    pending: Pending | undefined;
    send: (
      frame: FoundryDeviceChannelFrame,
    ) => Effect.Effect<void, FoundryDeviceError | Socket.SocketError>;
    close: Effect.Effect<void, Socket.SocketError>;
  };
  const active = new Map<FoundryDeviceId, Lease>();
  const current = Effect.fn("DeviceChannel.current")(function* (deviceId: FoundryDeviceId) {
    const lease = active.get(deviceId);
    if (!lease) return yield* new FoundryDeviceError({ code: "unavailable" });
    yield* registry.checkChannel(lease.device, lease.channelGeneration);
    if (active.get(deviceId) !== lease)
      return yield* new FoundryDeviceError({ code: "channel_superseded" });
    return lease;
  });
  const projects = Effect.fn("DeviceChannel.projects")(function* (
    grant: FoundryGatewayGrant,
    validate: Effect.Effect<void, FoundryGatewayError>,
  ) {
    const lease = yield* current(grant.deviceId).pipe(
      Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })),
    );
    if (
      !lease.httpRead ||
      lease.channelGeneration !== grant.channelGeneration ||
      lease.device.generation !== grant.generation ||
      lease.device.instanceId !== grant.instanceId ||
      lease.device.environmentId !== grant.environmentId
    )
      return yield* new FoundryGatewayError({ code: "forbidden" });
    const pending: Pending = {
      grant,
      validate,
      requestId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
      reply: yield* Deferred.make<ProjectSnapshot, FoundryGatewayError>(),
      started: false,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (lease.pending) return false;
        lease.pending = pending;
        return true;
      }).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Effect.fail(new FoundryGatewayError({ code: "capacity" })),
        ),
      ),
      () =>
        Effect.gen(function* () {
          if (lease.pending !== pending) return;
          lease.pending = undefined;
          if (pending.started) yield* lease.close.pipe(Effect.ignore);
        }),
    );
    yield* validate;
    yield* registry
      .checkChannel(lease.device, lease.channelGeneration)
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "forbidden" })));
    if (active.get(grant.deviceId) !== lease)
      return yield* new FoundryGatewayError({ code: "forbidden" });
    pending.started = true;
    yield* lease
      .send({
        type: "projects-read",
        connectionId: lease.connectionId,
        requestId: pending.requestId,
        grant,
      })
      .pipe(Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })));
    return yield* Deferred.await(pending.reply).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        isGatewayError(error) ? error : new FoundryGatewayError({ code: "unavailable" }),
      ),
    );
  }, Effect.scoped);
  const serve = Effect.fn("DeviceChannel.serve")(
    function* (socket: Socket.Socket) {
      const io = yield* openFrames(socket);
      yield* Effect.gen(function* () {
        const challenge: FoundryDeviceChallenge = {
          type: "challenge",
          protocolVersion: "1",
          origin,
          instanceId: yield* identity.readIdentity,
          nonce: base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie)),
        };
        yield* io.send(challenge);
        const hello = yield* io.read.pipe(Effect.timeout("10 seconds"));
        if (hello.type !== "hello")
          return yield* new FoundryDeviceError({ code: "channel_protocol" });
        const device = yield* registry.get(hello.deviceId);
        if (device.revoked) return yield* new FoundryDeviceError({ code: "revoked" });
        if (
          hello.instanceId !== challenge.instanceId ||
          hello.instanceId !== device.instanceId ||
          hello.environmentId !== device.environmentId ||
          hello.generation !== device.generation ||
          !verifyChannel(challenge, hello, device.publicKey)
        )
          return yield* new FoundryDeviceError({ code: "invalid_proof" });
        const channelGeneration = yield* registry.claimChannel(device);
        const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const lease: Lease = {
          device,
          channelGeneration,
          connectionId,
          httpRead: hello.httpRead === true,
          pending: undefined,
          send: io.send,
          close: io.writer.write(new Socket.CloseEvent(1008, "Gateway request ended")),
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => active.set(device.deviceId, lease)),
          () =>
            Effect.gen(function* () {
              if (active.get(device.deviceId) === lease) active.delete(device.deviceId);
              if (lease.pending)
                yield* Deferred.fail(
                  lease.pending.reply,
                  new FoundryGatewayError({ code: "unavailable" }),
                );
            }),
        );
        yield* io.send({ type: "ready", connectionId, channelGeneration });
        let sequence = 1;
        while (true) {
          const message = yield* io.read.pipe(Effect.timeout("30 seconds"));
          yield* registry.checkChannel(device, channelGeneration);
          if (message.type === "heartbeat") {
            if (message.connectionId !== connectionId || message.sequence !== sequence)
              return yield* new FoundryDeviceError({ code: "channel_protocol" });
            yield* io.send({ type: "ack", connectionId, sequence });
            sequence++;
            continue;
          }
          const pending = lease.pending;
          if (
            !pending ||
            (message.type !== "projects-result" && message.type !== "projects-failed") ||
            message.connectionId !== connectionId ||
            message.requestId !== pending.requestId
          )
            return yield* new FoundryDeviceError({ code: "channel_protocol" });
          const authority = yield* pending.validate.pipe(Effect.result);
          if (lease.pending === pending) lease.pending = undefined;
          if (authority._tag === "Failure") yield* Deferred.fail(pending.reply, authority.failure);
          else if (message.type === "projects-result")
            yield* Deferred.succeed(pending.reply, message.snapshot);
          else
            yield* Deferred.fail(pending.reply, new FoundryGatewayError({ code: "unavailable" }));
        }
      }).pipe(
        Effect.catch((error) =>
          io
            .send({
              type: "error",
              code: isDeviceError(error) ? error.code : "unavailable",
            })
            .pipe(Effect.ignore),
        ),
        Effect.ensuring(
          io.writer.write(new Socket.CloseEvent(1008, "Device channel closed")).pipe(Effect.ignore),
        ),
      );
    },
    Effect.scoped,
    Effect.ignore(),
  );
  return DeviceChannel.of({ serve, current, projects });
});
export const layer = Layer.effect(DeviceChannel, make);
