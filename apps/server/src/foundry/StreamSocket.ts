import { FoundryGatewayError } from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

export const upgrade = Effect.fn("StreamSocket.upgrade")(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    delete incoming.headers["sec-websocket-extensions"];
    const socket = yield* request.upgrade;
    return Socket.make({
      reader: socket.reader,
      writer: socket.writer.pipe(
        Effect.map((writer) => {
          const write: Socket.Writer["write"] = (frame) =>
            Effect.suspend(() => {
              if (incoming.socket.writableLength > 262144) {
                incoming.socket.destroy();
                return Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketWriteError({ cause: "Foundry stream output limit" }),
                  }),
                );
              }
              return writer.write(frame);
            });
          return { write, writeAll: (frames) => Effect.forEach(frames, write, { discard: true }) };
        }),
      ),
    });
  },
  Effect.mapError(() => new FoundryGatewayError({ code: "unavailable" })),
);

export const connect = Effect.fn("StreamSocket.connect")(function* (
  url: string,
  headers: Record<string, string> = {},
) {
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new NodeWS.WebSocket(url, {
        headers,
        followRedirects: false,
        handshakeTimeout: 10000,
        maxPayload: 262144,
        perMessageDeflate: false,
      });
      socket.on("error", () => undefined);
      return socket;
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  return yield* Socket.fromWebSocket(Effect.succeed(ws), {
    highWaterMark: 262144,
    openTimeout: "10 seconds",
  });
});
