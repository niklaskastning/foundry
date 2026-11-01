import * as Schema from "effect/Schema";
import { AuthSessionId, EnvironmentId } from "./baseSchemas.ts";
import { AuthOrchestrationReadScope } from "./auth.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";

export const FoundryGatewayGrantId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("FoundryGatewayGrantId"),
);
export const FoundryGatewayTarget = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
});
export const FoundryGatewayGrantRequest = Schema.Struct({
  ...FoundryGatewayTarget.fields,
  scopes: Schema.Tuple([Schema.Literal(AuthOrchestrationReadScope)]),
});
export const FoundryGatewayGrantLookup = Schema.Struct({
  ...FoundryGatewayTarget.fields,
  grantId: FoundryGatewayGrantId,
});
export const FoundryGatewayGrant = Schema.Struct({
  ...FoundryGatewayGrantRequest.fields,
  grantId: FoundryGatewayGrantId,
  protocolVersion: Schema.Literal("1"),
  instanceId: FoundryInstanceId,
  origin: Schema.String,
  operatorId: Schema.String,
  clientSessionId: AuthSessionId,
  subject: Schema.String,
  generation: Schema.Int,
  channelGeneration: Schema.Int,
  expiresAt: Schema.Number,
});
export type FoundryGatewayGrant = typeof FoundryGatewayGrant.Type;

export class FoundryGatewayError extends Schema.TaggedError<FoundryGatewayError>()(
  "FoundryGatewayError",
  {
    code: Schema.Literals(["invalid_request", "forbidden", "unavailable", "capacity"]),
  },
) {
  override get message(): string {
    return `Foundry gateway operation rejected (${this.code}).`;
  }
}
