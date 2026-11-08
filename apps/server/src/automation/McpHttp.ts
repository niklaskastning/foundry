import {
  AutomationMachineCredentialError,
  AUTOMATION_API_V1,
  AutomationControlCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Application from "./Application.ts";
import * as Control from "./Control.ts";
import * as MachineAccess from "./MachineAccess.ts";
import { Read, Start, foundryMcpTools } from "./mcpTools.ts";

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const Call = Schema.Struct({ name: Schema.String, arguments: Schema.Unknown });
const isCredentialError = Schema.is(AutomationMachineCredentialError);
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(Message));
const decodeCall = Schema.decodeUnknownEffect(Call);
const decodeQuery = Schema.decodeUnknownEffect(Read, {
  onExcessProperty: "error",
});
const decodeStart = Schema.decodeUnknownEffect(Start, { onExcessProperty: "error" });
const decodeControl = Schema.decodeUnknownEffect(AutomationControlCommand, {
  onExcessProperty: "error",
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const application = yield* Application.Application;
    const control = yield* Control.Control;
    const access = yield* MachineAccess.MachineAccess;

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `${AUTOMATION_API_V1}/mcp`,
        Effect.succeed(HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })),
      ),
      HttpRouter.add(
        "POST",
        `${AUTOMATION_API_V1}/mcp`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* access.read(request);
          const text = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
              (state, chunk) => {
                state.size += chunk.byteLength;
                if (state.size > 3 * 1024 * 1024) return Effect.fail("invalid_input");
                state.chunks.push(chunk);
                return Effect.succeed(state);
              },
            ),
            Effect.map((state) => new TextDecoder().decode(Buffer.concat(state.chunks))),
          );
          const message = yield* decodeMessage(text);
          const respond = (result: unknown) =>
            HttpServerResponse.jsonUnsafe(
              { jsonrpc: "2.0", id: message.id, result },
              { headers: { "cache-control": "no-store" } },
            );
          if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
          switch (message.method) {
            case "initialize":
              return respond({
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "foundry", version: "1" },
              });
            case "ping":
              return respond({});
            case "tools/list":
              return respond({ tools: foundryMcpTools });
            case "tools/call": {
              const call = yield* decodeCall(message.params);
              const result = yield* Effect.gen(function* () {
                if (call.name === "foundry_query")
                  return yield* application.query(request, yield* decodeQuery(call.arguments));
                if (call.name === "foundry_start")
                  return yield* application.command(request, yield* decodeStart(call.arguments));
                if (call.name === "foundry_control")
                  return yield* control.execute(request, yield* decodeControl(call.arguments));
                return yield* Effect.fail("invalid_input");
              }).pipe(
                Effect.match({
                  onSuccess: (value) => ({
                    content: [{ type: "text", text: JSON.stringify(value) }],
                  }),
                  onFailure: () => ({
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: "Request rejected. Check scope, input, current run revision and service availability.",
                      },
                    ],
                  }),
                }),
              );
              return respond(result);
            }
            default:
              return HttpServerResponse.jsonUnsafe({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              });
          }
        }).pipe(
          Effect.orElseSucceed((error) =>
            isCredentialError(error)
              ? HttpServerResponse.jsonUnsafe(
                  { code: error.code },
                  {
                    status: error.code === "unavailable" ? 503 : 403,
                    headers: { "cache-control": "no-store" },
                  },
                )
              : HttpServerResponse.jsonUnsafe(
                  { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
                  { status: 400, headers: { "cache-control": "no-store" } },
                ),
          ),
        ),
      ),
    );
  }),
);
