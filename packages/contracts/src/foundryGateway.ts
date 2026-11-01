import * as Schema from "effect/Schema";
import { AuthSessionId, EnvironmentId } from "./baseSchemas.ts";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
} from "./auth.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";

export const FoundryDeviceGrantKind = Schema.Literals([
  "clientAccess",
  "automationExecution",
  "sandboxProvisioning",
]);
export const FoundryDeviceGrant = Schema.Struct({
  deviceId: FoundryDeviceId,
  kind: FoundryDeviceGrantKind,
  enabled: Schema.Boolean,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type FoundryDeviceGrant = typeof FoundryDeviceGrant.Type;
export const FoundryCatalogDevice = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  revoked: Schema.Boolean,
  online: Schema.Boolean,
  rpcReady: Schema.Boolean,
  clientAccess: Schema.Struct({ enabled: Schema.Boolean, generation: Schema.Int }),
});
export type FoundryCatalogDevice = typeof FoundryCatalogDevice.Type;
export const FoundryDeviceCatalog = Schema.Struct({
  instanceId: FoundryInstanceId,
  devices: Schema.Array(FoundryCatalogDevice),
  canManage: Schema.Boolean,
  scopes: Schema.Array(Schema.String),
});
export type FoundryDeviceCatalog = typeof FoundryDeviceCatalog.Type;
export const FoundryDeviceGrantUpdate = Schema.Struct({
  ...FoundryDeviceGrant.fields,
});

export const FoundryGatewayGrantId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("FoundryGatewayGrantId"),
);
export const FoundryGatewayTarget = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
});
export const FoundryGatewayGrantRequest = Schema.Struct({
  ...FoundryGatewayTarget.fields,
  scopes: Schema.Array(
    Schema.Literals([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthTerminalReadScope,
      AuthTerminalOperateScope,
      AuthFilesystemReadScope,
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export const FoundryGatewayGrantLookup = Schema.Struct({
  ...FoundryGatewayTarget.fields,
  grantId: FoundryGatewayGrantId,
});
export const FoundryGatewayGrant = Schema.Struct({
  ...FoundryGatewayGrantRequest.fields,
  grantId: FoundryGatewayGrantId,
  protocolVersion: Schema.Literal("2"),
  grantKind: Schema.Literal("clientAccess"),
  accessGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
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

export const FoundryGatewaySocketTicket = Schema.Struct({
  ticket: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  wsTicket: Schema.String,
  expiresAt: Schema.Number,
});
export type FoundryGatewaySocketTicket = typeof FoundryGatewaySocketTicket.Type;

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
