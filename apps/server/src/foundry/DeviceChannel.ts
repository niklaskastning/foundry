import {
  FoundryDeviceError,
  type FoundryDeviceChallenge,
  type FoundryDevice,
  type FoundryDeviceId,
} from "@t3tools/contracts";
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

export class DeviceChannel extends Context.Service<
  DeviceChannel,
  {
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
  const active = new Map<FoundryDeviceId, { device: FoundryDevice; channelGeneration: number }>();
  const current = Effect.fn("DeviceChannel.current")(function* (deviceId: FoundryDeviceId) {
    const lease = active.get(deviceId);
    if (!lease) return yield* new FoundryDeviceError({ code: "unavailable" });
    yield* registry.checkChannel(lease.device, lease.channelGeneration);
    if (active.get(deviceId) !== lease)
      return yield* new FoundryDeviceError({ code: "channel_superseded" });
    return lease;
  });
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
        const lease = { device, channelGeneration };
        yield* Effect.acquireRelease(
          Effect.sync(() => active.set(device.deviceId, lease)),
          () =>
            Effect.sync(() => {
              if (active.get(device.deviceId) === lease) active.delete(device.deviceId);
            }),
        );
        yield* io.send({ type: "ready", connectionId, channelGeneration });
        let sequence = 1;
        while (true) {
          const message = yield* io.read.pipe(Effect.timeout("30 seconds"));
          if (
            message.type !== "heartbeat" ||
            message.connectionId !== connectionId ||
            message.sequence !== sequence
          )
            return yield* new FoundryDeviceError({ code: "channel_protocol" });
          yield* registry.checkChannel(device, channelGeneration);
          yield* io.send({ type: "ack", connectionId, sequence });
          sequence++;
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
  return DeviceChannel.of({ serve, current });
});
export const layer = Layer.effect(DeviceChannel, make);
