import { FoundryGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

export const bridge = Effect.fn("StreamBridge.bridge")(
  function* (
    left: Socket.Socket,
    right: Socket.Socket,
    validate: Effect.Effect<void, FoundryGatewayError>,
  ) {
    const check = validate.pipe(Effect.timeout("2 seconds"));
    const a = yield* left.reader;
    const b = yield* right.reader;
    const aw = yield* left.writer;
    const bw = yield* right.writer;
    const copy = Effect.fn("StreamBridge.copy")(function* (
      reader: Socket.Reader,
      writer: Socket.Writer,
    ) {
      while (true) {
        const frames = yield* reader.pull;
        let bytes = 0;
        for (const frame of frames) {
          bytes +=
            typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.length;
          if (bytes > 262144) return yield* new FoundryGatewayError({ code: "capacity" });
          yield* check;
          yield* writer.write(frame).pipe(Effect.timeout("5 seconds"));
        }
      }
    });
    const authority = Effect.gen(function* () {
      while (true) {
        yield* check;
        yield* Effect.sleep("1 second");
      }
    });
    return yield* Effect.raceFirst(Effect.raceFirst(copy(a, bw), copy(b, aw)), authority).pipe(
      Effect.ensuring(
        Effect.all(
          [
            aw.write(new Socket.CloseEvent(1011, "Foundry stream ended")),
            bw.write(new Socket.CloseEvent(1011, "Foundry stream ended")),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("5 seconds"), Effect.ignore),
      ),
    );
  },
  Effect.scoped,
  Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })),
);
