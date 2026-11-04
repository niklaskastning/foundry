import {
  AutomationTriggerQuery,
  AutomationTriggerCommand,
  AutomationApplicationQuery,
  AutomationApplicationCommand,
  AutomationControlCommand,
  AutomationInboxQuery,
  AutomationInboxMark,
} from "@t3tools/contracts";
import * as Application from "./Application.ts";
import * as Control from "./Control.ts";
import * as Inbox from "./Inbox.ts";
import * as Triggers from "./Triggers.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const application = yield* Application.Application;
    const control = yield* Control.Control;
    const inbox = yield* Inbox.Inbox;
    const triggers = yield* Triggers.Triggers;
    const route = <A, I, E>(
      path: string,
      schema: Schema.Codec<A, I>,
      operation: (
        request: HttpServerRequest.HttpServerRequest,
        input: A,
      ) => Effect.Effect<unknown, E>,
    ) =>
      HttpRouter.add(
        "POST",
        `/api/foundry/automation/${path}`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* HttpServerRequest.schemaBodyJson(schema);
          const result = yield* operation(request, input);
          return HttpServerResponse.jsonUnsafe(result, {
            headers: { "cache-control": "no-store" },
          });
        }).pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(3 * 1024 * 1024)),
          Effect.catch((error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  [
                    "AutomationTriggerError",
                    "AutomationApplicationError",
                    "AutomationControlError",
                    "AutomationInboxError",
                  ].includes(String(error._tag))
                  ? {
                      _tag: error._tag,
                      ...("code" in error ? { code: error.code } : {}),
                      ...("reason" in error ? { reason: error.reason } : {}),
                    }
                  : { _tag: "AutomationApplicationError", code: "invalid_input" },
                { status: 409, headers: { "cache-control": "no-store" } },
              ),
            ),
          ),
        ),
      );
    return Layer.mergeAll(
      route("triggers/query", AutomationTriggerQuery, triggers.query),
      route("triggers/command", AutomationTriggerCommand, triggers.command),
      route("query", AutomationApplicationQuery, application.query),
      route("command", AutomationApplicationCommand, application.command),
      route("control", AutomationControlCommand, control.execute),
      route("inbox/query", AutomationInboxQuery, inbox.query),
      route("inbox/mark", AutomationInboxMark, inbox.mark),
    );
  }),
);
