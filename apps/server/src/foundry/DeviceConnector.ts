import { NodeWS } from "@effect/platform-node/NodeSocket";
import { FoundryDeviceError, type FoundryDevice, type EnvironmentId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { signChannel } from "./DeviceProof.ts";
import { openFrames } from "./DeviceChannelProtocol.ts";

const isDeviceError = Schema.is(FoundryDeviceError);

export const makeSocket = Effect.fn("DeviceConnector.makeSocket")(function* (
  origin: string,
  access?: {
    readonly origin: string;
    readonly clientId: Redacted.Redacted<string>;
    readonly clientSecret: Redacted.Redacted<string>;
  },
) {
  if (
    !URL.canParse(origin) ||
    new URL(origin).origin !== origin ||
    new URL(origin).protocol !== "https:" ||
    (access && access.origin !== origin)
  )
    return yield* new FoundryDeviceError({ code: "configuration" });
  return yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(() => {
        const ws = new NodeWS.WebSocket(
          `${origin.replace(/^https:/, "wss:")}/api/foundry/devices/channel`,
          {
            followRedirects: false,
            handshakeTimeout: 10000,
            maxPayload: 4096,
            perMessageDeflate: false,
            headers: access
              ? {
                  "CF-Access-Client-Id": Redacted.value(access.clientId),
                  "CF-Access-Client-Secret": Redacted.value(access.clientSecret),
                }
              : {},
          },
        );
        // ws can emit an error after the scoped reader removes listeners during an interrupted dial.
        ws.on("error", () => undefined);
        return ws;
      }),
      (ws) => Effect.sync(() => ws.terminate()),
    ),
    { openTimeout: "10 seconds", highWaterMark: 16 },
  );
});

export interface ConnectionOptions {
  readonly device: FoundryDevice;
  readonly origin: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly localEnvironmentId: Effect.Effect<EnvironmentId, FoundryDeviceError>;
  readonly connected: Effect.Effect<void>;
}

export const runOnce = Effect.fn("DeviceConnector.runOnce")(function* (
  socket: Socket.Socket,
  options: ConnectionOptions,
) {
  const checkEnvironment = Effect.gen(function* () {
    if (
      (yield* options.localEnvironmentId) !== options.device.environmentId ||
      options.device.revoked
    )
      return yield* new FoundryDeviceError({ code: "configuration" });
  });
  yield* checkEnvironment;
  const io = yield* openFrames(socket);
  const read = io.read.pipe(
    Effect.filterOrFail(
      (frame) => frame.type !== "error",
      (frame) =>
        new FoundryDeviceError({
          code:
            frame.type === "error" && frame.code === "revoked"
              ? "revoked"
              : frame.type === "error" && frame.code === "unavailable"
                ? "unavailable"
                : "invalid_proof",
        }),
    ),
    Effect.timeout("10 seconds"),
  );
  const challenge = yield* read;
  if (
    challenge.type !== "challenge" ||
    challenge.instanceId !== options.device.instanceId ||
    challenge.origin !== options.origin
  )
    return yield* new FoundryDeviceError({ code: "invalid_proof" });
  const hello = yield* Effect.try({
    try: () => signChannel(challenge, options.device, Redacted.value(options.privateKey)),
    catch: () => new FoundryDeviceError({ code: "invalid_proof" }),
  });
  yield* io.send(hello);
  const ready = yield* read;
  if (ready.type !== "ready") return yield* new FoundryDeviceError({ code: "channel_protocol" });
  yield* options.connected;
  let sequence = 1;
  while (true) {
    yield* checkEnvironment;
    yield* io.send({ type: "heartbeat", connectionId: ready.connectionId, sequence });
    const ack = yield* read;
    if (ack.type !== "ack" || ack.connectionId !== ready.connectionId || ack.sequence !== sequence)
      return yield* new FoundryDeviceError({ code: "channel_protocol" });
    sequence++;
    yield* Effect.sleep("10 seconds");
  }
}, Effect.scoped);

export const run = Effect.fn("DeviceConnector.run")(function* (
  socket: Socket.Socket,
  options: ConnectionOptions,
) {
  let delay = 1000;
  while (true) {
    const outcome = yield* runOnce(socket, {
      ...options,
      connected: Effect.sync(() => {
        delay = 1000;
      }).pipe(Effect.andThen(options.connected)),
    }).pipe(Effect.result);
    if (
      outcome._tag === "Failure" &&
      isDeviceError(outcome.failure) &&
      outcome.failure.code !== "unavailable"
    )
      return yield* outcome.failure;
    yield* Console.log("Foundry device channel disconnected; retrying with a fresh challenge.");
    yield* Effect.sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
});
