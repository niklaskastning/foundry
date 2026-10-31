import type { FoundryReadiness } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as InstanceDescriptor from "./InstanceDescriptor.ts";

const headers = { "cache-control": "no-store" };
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* InstanceDescriptor.InstanceDescriptor;
    return Layer.merge(
      HttpRouter.add(
        "GET",
        "/.well-known/foundry",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const query = new URL(request.url, "http://localhost").searchParams;
          return yield* service
            .negotiate({
              protocolVersion:
                query.getAll("protocolVersion").length === 1
                  ? (query.get("protocolVersion") ?? undefined)
                  : undefined,
              capabilities: query.getAll("capability"),
              requiredCapabilities: query.getAll("requiredCapability"),
            })
            .pipe(
              Effect.map((descriptor) => HttpServerResponse.jsonUnsafe(descriptor, { headers })),
              Effect.catchTags({
                FoundryNegotiationError: (error) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      { ...error, message: error.message },
                      { status: error.code === "protocol_version_required" ? 400 : 409, headers },
                    ),
                  ),
                InstanceIdentityError: (error) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      { code: "instance_identity_unavailable", message: error.message },
                      { status: 503, headers },
                    ),
                  ),
              }),
            );
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/foundry/ready",
        service
          .negotiate({ protocolVersion: "1", capabilities: [], requiredCapabilities: [] })
          .pipe(
            Effect.map(() =>
              HttpServerResponse.jsonUnsafe({ ready: true } satisfies FoundryReadiness, {
                headers,
              }),
            ),
            Effect.orElseSucceed(() =>
              HttpServerResponse.jsonUnsafe({ ready: false } satisfies FoundryReadiness, {
                status: 503,
                headers,
              }),
            ),
          ),
      ),
    );
  }),
);
