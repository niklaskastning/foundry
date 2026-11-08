import * as McpHttp from "./McpHttp.ts";
import * as MachineAccess from "./MachineAccess.ts";
import {
  AUTOMATION_API_V1,
  AutomationApiError,
  AutomationMachineCredentialError,
  AutomationApiOperations,
  AutomationApplicationError,
  AutomationControlError,
  AutomationInboxError,
  AutomationTriggerError,
  FoundryGatewayError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { jsonSchema } from "./apiJsonSchema.ts";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Application from "./Application.ts";
import * as Control from "./Control.ts";
import * as Inbox from "./Inbox.ts";
import * as Triggers from "./Triggers.ts";

const decodeLargeDefinition = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ op: Schema.Literal("activateDefinition") })),
);
const headers = { "cache-control": "no-store" };
const isDomainError = Schema.is(
  Schema.Union([
    AutomationMachineCredentialError,
    AutomationApplicationError,
    AutomationControlError,
    AutomationInboxError,
    AutomationTriggerError,
    FoundryGatewayError,
  ]),
);
const isCode = Schema.is(AutomationApiError.fields.code);
const failure = (error: unknown) => {
  const candidate = isDomainError(error)
    ? "code" in error
      ? error.code
      : error.reason
    : undefined;
  const code = isCode(candidate) ? candidate : "unavailable";
  const status =
    code === "invalid_input"
      ? 400
      : code === "forbidden"
        ? 403
        : code === "not_found"
          ? 404
          : code === "unavailable"
            ? 503
            : 409;
  return HttpServerResponse.jsonUnsafe({ code }, { status, headers });
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const contract = {
      version: "1",
      basePath: AUTOMATION_API_V1,
      operations: Object.fromEntries(
        Object.entries(AutomationApiOperations).map(([name, operation]) => [
          name,
          {
            method: "POST",
            path: `${AUTOMATION_API_V1}/${operation.path}`,
            input: jsonSchema(operation.input),
            output: jsonSchema(operation.output),
          },
        ]),
      ),
      error: jsonSchema(AutomationApiError),
    };

    const application = yield* Application.Application;
    const control = yield* Control.Control;
    const inbox = yield* Inbox.Inbox;
    const triggers = yield* Triggers.Triggers;
    const machineAccess = yield* MachineAccess.MachineAccess;
    const route = <A, I, E>(
      operation: { readonly path: string; readonly input: Schema.Codec<A, I> },
      execute: (
        request: HttpServerRequest.HttpServerRequest,
        input: A,
      ) => Effect.Effect<unknown, E>,
    ) =>
      HttpRouter.add(
        "POST",
        `${AUTOMATION_API_V1}/${operation.path}`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => ({ size: 0, parts: [] as Array<string>, decoder: new TextDecoder() }),
              (state, chunk) => {
                state.size += chunk.byteLength;
                if (state.size > (operation.path === "command" ? 64 : 3) * 1024 * 1024)
                  return Effect.fail(new AutomationApplicationError({ code: "invalid_input" }));
                state.parts.push(state.decoder.decode(chunk, { stream: true }));
                return Effect.succeed(state);
              },
            ),
            Effect.flatMap((state) => {
              const text = state.parts.join("") + state.decoder.decode();
              if (state.size <= 3 * 1024 * 1024) return Effect.succeed(text);
              return decodeLargeDefinition(text).pipe(Effect.as(text));
            }),
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(operation.input), {
                onExcessProperty: "error",
              }),
            ),
            Effect.mapError(() => new AutomationApplicationError({ code: "invalid_input" })),
          );
          return HttpServerResponse.jsonUnsafe(yield* execute(request, input), { headers });
        }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
      );
    return Layer.mergeAll(
      McpHttp.layer,
      route(AutomationApiOperations.credentialIssue, machineAccess.issue),
      route(AutomationApiOperations.credentialList, machineAccess.list),
      route(AutomationApiOperations.credentialRevoke, machineAccess.revoke),
      route(AutomationApiOperations.query, application.query),
      route(AutomationApiOperations.command, application.command),
      route(AutomationApiOperations.control, control.execute),
      route(AutomationApiOperations.inboxQuery, inbox.query),
      route(AutomationApiOperations.inboxMark, inbox.mark),
      route(AutomationApiOperations.triggersQuery, triggers.query),
      route(AutomationApiOperations.triggersCommand, triggers.command),
      HttpRouter.add(
        "POST",
        `${AUTOMATION_API_V1}/contract`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* machineAccess.read(request);
          return HttpServerResponse.jsonUnsafe(contract, { headers });
        }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
      ),
      HttpRouter.add(
        "*",
        "/api/foundry/:version/automation/*",
        Effect.succeed(failure(new AutomationApplicationError({ code: "not_found" }))),
      ),
    );
  }),
);
