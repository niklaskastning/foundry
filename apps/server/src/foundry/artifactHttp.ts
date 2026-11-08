import { FoundryArtifactError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ThreadArchiveAccess from "./ThreadArchiveAccess.ts";
import * as ArtifactAccess from "./ArtifactAccess.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isArtifactError = Schema.is(FoundryArtifactError);
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const access = yield* ArtifactAccess.ArtifactAccess;
    const archives = yield* ThreadArchiveAccess.ThreadArchiveAccess;
    const route = (
      path: "/api/foundry/artifacts" | "/api/foundry/archives" | "/api/foundry/devices/channel",
      machine: boolean,
    ) =>
      HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
            return yield* new FoundryArtifactError({ code: "invalid_request" });
          const body = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
              (state, chunk) => {
                if (state.size + chunk.byteLength > 1_048_576)
                  return Effect.fail(new FoundryArtifactError({ code: "capacity" }));
                state.chunks.push(chunk);
                state.size += chunk.byteLength;
                return Effect.succeed(state);
              },
            ),
            Effect.map((state) => {
              const bytes = new Uint8Array(state.size);
              let offset = 0;
              for (const chunk of state.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              return new TextDecoder().decode(bytes);
            }),
            Effect.flatMap(decodeJson),
            Effect.mapError((error) =>
              isArtifactError(error)
                ? error
                : new FoundryArtifactError({ code: "invalid_request" }),
            ),
          );
          const archiveMachine =
            machine &&
            typeof body === "object" &&
            body !== null &&
            "protocolVersion" in body &&
            body.protocolVersion === "archive-1";
          const result = archiveMachine
            ? yield* archives.machine(body)
            : path === "/api/foundry/archives"
              ? yield* archives.client(request, body)
              : machine
                ? yield* access.machine(body)
                : yield* access.client(request, body);
          return HttpServerResponse.jsonUnsafe(result ?? null, { headers });
        }).pipe(
          Effect.catchTags({
            FoundryArchiveError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: error.code, message: error.message },
                  {
                    headers,
                    status:
                      error.code === "forbidden"
                        ? 403
                        : error.code === "invalid_request"
                          ? 400
                          : error.code === "unavailable"
                            ? 503
                            : 409,
                  },
                ),
              ),
            FoundryArtifactError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: error.code, message: error.message },
                  {
                    headers,
                    status:
                      error.code === "forbidden"
                        ? 403
                        : error.code === "invalid_request"
                          ? 400
                          : error.code === "capacity"
                            ? 507
                            : error.code === "unavailable"
                              ? 503
                              : 409,
                  },
                ),
              ),
          }),
        ),
      );
    return Layer.mergeAll(
      route("/api/foundry/artifacts", false),
      route("/api/foundry/archives", false),
      route("/api/foundry/devices/channel", true),
    );
  }),
);
