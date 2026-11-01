import { expect, it } from "@effect/vitest";
import { FoundryGatewayError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { bridge } from "./StreamBridge.ts";

it.effect.each(["slow", "oversize", "revoked"] as const)(
  "closes both stream ends without replay after %s",
  (mode) =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<string>();
      const writing = yield* Deferred.make<void>();
      const closes = yield* Queue.unbounded<void>();
      let writes = 0;
      let valid = true;
      const write: Socket.Writer["write"] = (frame) => {
        if (Socket.isCloseEvent(frame)) return Queue.offer(closes, undefined).pipe(Effect.asVoid);
        writes++;
        return Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never));
      };
      const writer = Effect.succeed({
        write,
        writeAll: (frames: readonly [string | Uint8Array, ...(string | Uint8Array)[]]) =>
          Effect.forEach(frames, write, { discard: true }),
      });
      const left = Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(input).pipe(Effect.map((value) => [value] as const)),
          upgrade: () => Effect.void,
        }),
        writer,
      });
      const right = Socket.make({
        reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
        writer,
      });
      const fiber = yield* bridge(
        left,
        right,
        Effect.suspend(() =>
          valid ? Effect.void : Effect.fail(new FoundryGatewayError({ code: "forbidden" })),
        ),
      ).pipe(Effect.result, Effect.forkScoped);
      if (mode === "revoked") {
        valid = false;
        yield* TestClock.adjust("1 second");
      } else {
        yield* Queue.offer(
          input,
          mode === "oversize" ? "x".repeat(262145) : "one unconfirmed input",
        );
        if (mode === "slow") {
          yield* Deferred.await(writing);
          yield* TestClock.adjust("5 seconds");
        }
      }
      expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
      yield* Queue.take(closes);
      yield* Queue.take(closes);
      expect(writes).toBe(mode === "slow" ? 1 : 0);
    }).pipe(Effect.scoped),
);
