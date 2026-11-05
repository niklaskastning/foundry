import {
  AutomationMachineCredentialIssue,
  AutomationMachineCredentialError,
  type AutomationMachineCredential,
  type FoundryInstanceId,
  AUTOMATION_API_V1,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";
import * as MachineCredentials from "../foundry/MachineCredentials.ts";
import * as Factories from "./Factories.ts";

type Request = HttpServerRequest.HttpServerRequest;
export interface ReadIdentity {
  readonly instanceId: FoundryInstanceId;
  readonly operatorId: string;
  readonly factoryIds?: ReadonlyArray<string>;
}
const decodeIssue = Schema.decodeEffect(AutomationMachineCredentialIssue, {
  onExcessProperty: "error",
});
const isCredentialError = Schema.is(AutomationMachineCredentialError);
const isForbidden = Schema.is(Schema.Struct({ code: Schema.Literal("forbidden") }));
const mapError = (error: unknown) =>
  isCredentialError(error)
    ? error
    : isForbidden(error)
      ? new AutomationMachineCredentialError({ code: "forbidden" })
      : new AutomationMachineCredentialError({ code: "unavailable" });
export class MachineAccess extends Context.Service<
  MachineAccess,
  {
    readonly read: (
      request: Request,
    ) => Effect.Effect<ReadIdentity, AutomationMachineCredentialError>;
    readonly issue: (
      request: Request,
      input: AutomationMachineCredentialIssue,
    ) => Effect.Effect<
      { credential: AutomationMachineCredential; token: string | null },
      AutomationMachineCredentialError
    >;
    readonly list: (
      request: Request,
    ) => Effect.Effect<
      ReadonlyArray<AutomationMachineCredential>,
      AutomationMachineCredentialError
    >;
    readonly revoke: (
      request: Request,
      input: { readonly id: string },
    ) => Effect.Effect<null, AutomationMachineCredentialError>;
  }
>()("t3/automation/MachineAccess") {}

const make = Effect.gen(function* () {
  const credentials = yield* MachineCredentials.MachineCredentials;
  const gateway = yield* GatewayGrants.GatewayGrants;
  const factories = yield* Factories.Factories;
  const read = Effect.fn("MachineAccess.read")(function* (request: Request) {
    const token = MachineCredentials.machineBearerToken(request.headers.authorization);
    if (token !== undefined) {
      const path = request.url.split("?", 1)[0];
      if (
        request.method !== "POST" ||
        (path !== `${AUTOMATION_API_V1}/query` && path !== `${AUTOMATION_API_V1}/contract`)
      )
        return yield* new AutomationMachineCredentialError({ code: "forbidden" });
      return yield* credentials.authenticate(token);
    }
    return yield* gateway.identityForRead(request);
  }, Effect.mapError(mapError));
  const manage = Effect.fn("MachineAccess.manage")(function* (request: Request) {
    if (MachineCredentials.machineBearerToken(request.headers.authorization) !== undefined)
      return yield* new AutomationMachineCredentialError({ code: "forbidden" });
    return yield* gateway.identityForWrite(request, "access:write");
  });
  const issue = Effect.fn("MachineAccess.issue")(function* (
    request: Request,
    raw: AutomationMachineCredentialIssue,
  ) {
    const input = yield* decodeIssue(raw).pipe(
      Effect.mapError(() => new AutomationMachineCredentialError({ code: "invalid_input" })),
    );
    const owner = yield* manage(request);
    yield* gateway.identityForRead(request);
    for (const factoryId of input.factoryIds) {
      yield* factories.readFactory(factoryId).pipe(
        Effect.mapError(
          (error) =>
            new AutomationMachineCredentialError({
              code: error.reason === "not_found" ? "invalid_input" : "unavailable",
            }),
        ),
      );
    }
    return yield* credentials.issue(owner, input);
  }, Effect.mapError(mapError));
  const list = Effect.fn("MachineAccess.list")(function* (request: Request) {
    return yield* credentials.list(yield* manage(request));
  }, Effect.mapError(mapError));
  const revoke = Effect.fn("MachineAccess.revoke")(function* (
    request: Request,
    input: { readonly id: string },
  ) {
    yield* credentials.revoke(yield* manage(request), input.id);
    return null;
  }, Effect.mapError(mapError));
  return MachineAccess.of({ read, issue, list, revoke });
});
export const layer = Layer.effect(MachineAccess, make);
