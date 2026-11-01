import { FoundryGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as GatewayGrants from "./GatewayGrants.ts";

const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const headers = { "cache-control": "no-store", pragma: "no-cache" };
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const grants = yield* GatewayGrants.GatewayGrants;
    const route = (operation: "create" | "inspect" | "remove") =>
      HttpRouter.add(
        "POST",
        `/api/foundry/gateway/grants/${operation}`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => new Uint8Array(0),
              (bytes, chunk) => {
                if (bytes.length + chunk.length > 4096)
                  return Effect.fail(new FoundryGatewayError({ code: "invalid_request" }));
                const next = new Uint8Array(bytes.length + chunk.length);
                next.set(bytes);
                next.set(chunk, bytes.length);
                return Effect.succeed(next);
              },
            ),
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.flatMap(decode),
            Effect.mapError(() => new FoundryGatewayError({ code: "invalid_request" })),
          );
          const result = yield* grants[operation](request, input);
          return result === undefined
            ? HttpServerResponse.empty({ status: 204, headers })
            : HttpServerResponse.jsonUnsafe(result, { headers });
        }).pipe(
          Effect.catchTags({
            FoundryGatewayError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: error.code, message: error.message },
                  {
                    headers,
                    status:
                      error.code === "invalid_request"
                        ? 400
                        : error.code === "capacity"
                          ? 429
                          : error.code === "unavailable"
                            ? 503
                            : 403,
                  },
                ),
              ),
          }),
        ),
      );
    return Layer.mergeAll(route("create"), route("inspect"), route("remove"));
  }),
);
