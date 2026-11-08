import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { FoundryInstanceId } from "./foundry.ts";

const Id = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
const Generation = Schema.Int.check(Schema.isGreaterThan(0));

export const FoundryProviderGrant = Schema.Struct({
  deviceId: FoundryDeviceId,
  deviceGeneration: Generation,
  allocationId: Schema.NullOr(Id),
  factoryId: Schema.NullOr(Id),
});
export type FoundryProviderGrant = typeof FoundryProviderGrant.Type;

const ConnectionConfiguration = Schema.Struct({
  id: Id,
  label: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  providerInstanceId: ProviderInstanceId,
  profileKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  generation: Generation,
  grants: Schema.Array(FoundryProviderGrant).check(Schema.isMaxLength(256)),
});

export const FoundryProviderModelCatalog = Schema.Struct({
  protocolVersion: Schema.Literal("1"),
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/)),
      name: Schema.String.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]{1,256}$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  defaultModel: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
}).check(
  Schema.makeFilter((catalog) =>
    catalog.models.some((model) => model.slug === catalog.defaultModel),
  ),
);
export type FoundryProviderModelCatalog = typeof FoundryProviderModelCatalog.Type;

export const FoundryProviderConnection = Schema.Struct({
  ...ConnectionConfiguration.fields,
  revoked: Schema.Boolean,
  lastIssuedExpiresAt: Schema.Finite,
  modelCatalog: Schema.optionalKey(FoundryProviderModelCatalog),
});
export type FoundryProviderConnection = typeof FoundryProviderConnection.Type;

export const SetFoundryProviderConnection = Schema.Struct({
  connection: ConnectionConfiguration,
  expectedGeneration: Schema.NullOr(Generation),
});
export type SetFoundryProviderConnection = typeof SetFoundryProviderConnection.Type;

export const FoundryProviderIssue = Schema.Struct({
  connectionId: Id,
  connectionGeneration: Generation,
  allocationId: Schema.NullOr(Id),
  factoryId: Schema.NullOr(Id),
});
export type FoundryProviderIssue = typeof FoundryProviderIssue.Type;

export const FoundryProviderMachineRequest = Schema.Struct({
  protocolVersion: Schema.Literal("provider-1"),
  instanceId: FoundryInstanceId,
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  generation: Generation,
  issuedAt: Schema.Finite,
  request: FoundryProviderIssue,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundryProviderMachineRequest = typeof FoundryProviderMachineRequest.Type;

export const ConnectFoundryProviderConnection = Schema.Struct({
  id: Id,
  label: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  providerInstanceId: ProviderInstanceId,
  expectedGeneration: Schema.NullOr(Generation),
});
export type ConnectFoundryProviderConnection = typeof ConnectFoundryProviderConnection.Type;
export const FoundryProviderConnectionSummary = Schema.Struct({
  id: Id,
  label: ConnectionConfiguration.fields.label,
  providerInstanceId: ProviderInstanceId,
  generation: Generation,
  revoked: Schema.Boolean,
  lastIssuedExpiresAt: Schema.Finite,
});
export type FoundryProviderConnectionSummary = typeof FoundryProviderConnectionSummary.Type;
export const FoundryProviderConnectionQuery = Schema.Struct({ op: Schema.Literal("list") });
export const FoundryProviderConnectionMutation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("connect"), input: ConnectFoundryProviderConnection }),
  Schema.Struct({ op: Schema.Literal("revoke"), id: Id }),
]);
export const FoundryProviderConnectionListResult = Schema.Struct({
  connections: Schema.Array(FoundryProviderConnectionSummary),
});
export const FoundryProviderConnectionMutationResult = Schema.Union([
  Schema.Struct({ connection: FoundryProviderConnectionSummary }),
  Schema.Struct({ lastIssuedExpiresAt: Schema.Finite }),
]);

export const FoundryProviderConnectionRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("connect"), input: ConnectFoundryProviderConnection }),
  Schema.Struct({ op: Schema.Literal("list") }),
  Schema.Struct({ op: Schema.Literal("set"), input: SetFoundryProviderConnection }),
  Schema.Struct({ op: Schema.Literal("revoke"), id: Id }),
]);

export class FoundryProviderConnectionError extends Schema.TaggedError<FoundryProviderConnectionError>()(
  "FoundryProviderConnectionError",
  {
    code: Schema.Literals([
      "invalid_input",
      "forbidden",
      "conflict",
      "login_required",
      "unavailable",
    ]),
  },
) {
  override get message(): string {
    return `Foundry provider connection rejected (${this.code}).`;
  }
}
