import { expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as StreamSocket from "./StreamSocket.ts";

it.live("buffers peer frames before the bridge acquires its reader", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" })),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    yield* Effect.callback<void>((resume) => {
      server.once("listening", () => resume(Effect.void));
      server.once("error", (error) => resume(Effect.die(error)));
    });
    const address = server.address();
    if (typeof address === "string" || address === null)
      return yield* Effect.die("Missing test port");
    const delivered = yield* Deferred.make<NodeWS.WebSocket>();
    yield* Effect.callback<NodeWS.WebSocket>((resume) => {
      server.once("connection", (peer) => {
        peer.send("first request");
        // Pong proves the preceding frame arrived before the bridge takes its reader.
        peer.once("pong", () => resume(Effect.succeed(peer)));
        peer.ping();
      });
    }).pipe(
      Effect.flatMap((peer) => Deferred.succeed(delivered, peer)),
      Effect.forkScoped,
    );
    const socket = yield* StreamSocket.connect(`ws://127.0.0.1:${address.port}`);
    const peer = yield* Deferred.await(delivered);
    const reader = yield* socket.reader;
    peer.send("after attachment");
    const frames = yield* reader.pull;
    expect(
      frames.map((frame) =>
        typeof frame === "string" ? frame : new TextDecoder().decode(frame),
      )[0],
    ).toBe("first request");
  }).pipe(Effect.scoped),
);
