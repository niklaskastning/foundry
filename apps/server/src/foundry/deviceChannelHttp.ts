import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as StreamSocket from "./StreamSocket.ts";
import * as DeviceChannel from "./DeviceChannel.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const channels = yield* DeviceChannel.DeviceChannel;
    const streams = yield* DeviceConfig.StreamGatewayEnabled;
    return Layer.merge(
      streams
        ? HttpRouter.add(
            "GET",
            "/api/foundry/devices/stream",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              yield* channels.attachStream(
                request.headers["x-foundry-stream-ticket"] ?? "",
                StreamSocket.upgrade(request),
              );
              return HttpServerResponse.empty();
            }).pipe(
              Effect.catchTags({
                FoundryGatewayError: () =>
                  Effect.succeed(HttpServerResponse.empty({ status: 403 })),
              }),
            ),
          )
        : Layer.empty,
      HttpRouter.add(
        "GET",
        "/api/foundry/devices/channel",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const incoming = NodeHttpServerRequest.toIncomingMessage(request);
          delete incoming.headers["sec-websocket-extensions"];
          const socket = yield* request.upgrade;
          yield* channels.serve(
            Socket.make({
              reader: socket.reader,
              writer: socket.writer.pipe(
                Effect.map((writer) => {
                  const write: Socket.Writer["write"] = (frame) =>
                    Effect.suspend(() => {
                      if (incoming.socket.writableLength > 262144) {
                        incoming.socket.destroy();
                        return Effect.fail(
                          new Socket.SocketError({
                            reason: new Socket.SocketWriteError({
                              cause: "Device channel output limit",
                            }),
                          }),
                        );
                      }
                      return writer.write(frame);
                    });
                  return {
                    write,
                    writeAll: (frames) => Effect.forEach(frames, write, { discard: true }),
                  };
                }),
              ),
            }),
          );
          return HttpServerResponse.empty();
        }),
      ),
    );
  }),
);
