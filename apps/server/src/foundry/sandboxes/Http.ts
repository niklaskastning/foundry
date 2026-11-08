import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FoundrySandboxCommand,
  FoundrySandboxError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ClientIdentity from "../ClientIdentity.ts";
import * as Allocations from "./Allocations.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const allocations = yield* Allocations.Allocations;
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof ClientIdentity.authenticate>>>();
    return HttpRouter.add(
      "POST",
      "/api/foundry/sandboxes",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const actor = yield* ClientIdentity.authenticate(request).pipe(
          Effect.provide(context),
          Effect.mapError(() => new FoundrySandboxError({ code: "forbidden" })),
        );
        const input = yield* HttpServerRequest.schemaBodyJson(FoundrySandboxCommand).pipe(
          Effect.mapError(() => new FoundrySandboxError({ code: "invalid_request" })),
        );
        if (
          !actor.client.scopes.includes(
            input.action === "list" || input.action === "get"
              ? AuthOrchestrationReadScope
              : AuthOrchestrationOperateScope,
          )
        )
          return yield* new FoundrySandboxError({ code: "forbidden" });
        const operator = actor.foundry.operatorId;
        const detail =
          input.action === "get" ? yield* allocations.get(operator, input.allocationId) : undefined;
        const result = detail
          ? {
              allocation: detail.allocation,
              archiveReceipt: detail.archive_receipt,
              setupLog: detail.setup_log,
            }
          : input.action === "list"
            ? yield* allocations.list(operator, input.workflow)
            : input.action === "request"
              ? yield* allocations.request(operator, input.request)
              : input.action !== "get"
                ? yield* allocations.control(
                    operator,
                    input.allocationId,
                    input.action,
                    input.action === "extend" ? input.expiresAt : undefined,
                  )
                : null;
        return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024)),
        Effect.catchTags({
          FoundrySandboxError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { code: error.code, message: error.message },
                {
                  status:
                    error.code === "forbidden"
                      ? 403
                      : error.code === "invalid_request"
                        ? 400
                        : error.code === "unavailable"
                          ? 503
                          : 409,
                  headers: { "cache-control": "no-store" },
                },
              ),
            ),
        }),
      ),
    );
  }),
);
