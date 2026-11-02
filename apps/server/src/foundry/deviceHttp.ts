import { FoundryDeviceError, FoundryEnrollmentRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as DeviceRegistry from "./DeviceRegistry.ts";

const headers = { "cache-control": "no-store" };
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(FoundryEnrollmentRequest));
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* DeviceRegistry.DeviceRegistry;
    return HttpRouter.add(
      "POST",
      "/api/foundry/devices/enroll",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json" ||
          Number(request.headers["content-length"] ?? 0) > 8192
        )
          return yield* new FoundryDeviceError({ code: "invalid_enrollment" });
        const input = yield* request.stream.pipe(
          Stream.runFoldEffect(
            () => new Uint8Array(0),
            (bytes, chunk) => {
              if (bytes.length + chunk.length > 8192)
                return Effect.fail(new FoundryDeviceError({ code: "invalid_enrollment" }));
              const next = new Uint8Array(bytes.length + chunk.length);
              next.set(bytes);
              next.set(chunk, bytes.length);
              return Effect.succeed(next);
            },
          ),
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.flatMap(decodeRequest),
          Effect.mapError(() => new FoundryDeviceError({ code: "invalid_enrollment" })),
        );
        return HttpServerResponse.jsonUnsafe(yield* registry.enroll(input), { headers });
      }).pipe(
        Effect.catchTags({
          FoundryDeviceError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { code: error.code, message: error.message },
                {
                  headers,
                  status:
                    error.code === "unavailable" ? 503 : error.code === "conflict" ? 409 : 403,
                },
              ),
            ),
        }),
      ),
    );
  }),
);
