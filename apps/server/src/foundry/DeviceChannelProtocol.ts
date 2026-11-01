import { FoundryDeviceChannelFrame, FoundryDeviceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";

const decode = Schema.decodeEffect(Schema.fromJsonString(FoundryDeviceChannelFrame));
const encode = Schema.encodeEffect(Schema.fromJsonString(FoundryDeviceChannelFrame));

export const openFrames = Effect.fn("DeviceChannelProtocol.openFrames")(function* (
  socket: Socket.Socket,
) {
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  let pending: Array<string | Uint8Array> = [];
  const read = Effect.suspend(() =>
    Effect.gen(function* () {
      if (!pending.length) pending = [...(yield* reader.pull)];
      if (pending.length > 16) return yield* new FoundryDeviceError({ code: "channel_protocol" });
      const frame = pending.shift()!;
      const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
      if (bytes.byteLength > 4096)
        return yield* new FoundryDeviceError({ code: "channel_protocol" });
      return yield* decode(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(() => new FoundryDeviceError({ code: "channel_protocol" })),
      );
    }),
  );
  const send = (frame: FoundryDeviceChannelFrame) =>
    encode(frame).pipe(
      Effect.mapError(() => new FoundryDeviceError({ code: "channel_protocol" })),
      Effect.flatMap((message) => writer.write(message)),
    );
  return { read, send, writer };
});
