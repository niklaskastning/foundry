import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { ServerAuthBootstrapMethod, ServerAuthSessionMethod } from "./auth.ts";

export const FoundryInstanceId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("FoundryInstanceId"),
);
export type FoundryInstanceId = typeof FoundryInstanceId.Type;

export const FOUNDRY_PROTOCOL_VERSION = "1";
export const FOUNDRY_CAPABILITIES = ["foundry.instance-descriptor"] as const;

export const FoundryDescriptor = Schema.Struct({
  protocolVersion: Schema.Literal(FOUNDRY_PROTOCOL_VERSION),
  instanceId: FoundryInstanceId,
  mainEnvironmentId: EnvironmentId,
  capabilities: Schema.Array(Schema.Literals(FOUNDRY_CAPABILITIES)),
  negotiatedCapabilities: Schema.Array(Schema.Literals(FOUNDRY_CAPABILITIES)),
  auth: Schema.Struct({
    bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
    sessionMethods: Schema.Array(ServerAuthSessionMethod),
  }),
});
export type FoundryDescriptor = typeof FoundryDescriptor.Type;

export class FoundryNegotiationError extends Schema.TaggedError<FoundryNegotiationError>()(
  "FoundryNegotiationError",
  {
    code: Schema.Literals([
      "protocol_version_required",
      "protocol_version_unsupported",
      "capability_unsupported",
    ]),
    supportedProtocolVersions: Schema.Array(Schema.String),
    supportedCapabilities: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "protocol_version_required":
        return "Supply protocolVersion=1 to request the Foundry descriptor.";
      case "protocol_version_unsupported":
        return "Unsupported Foundry protocol version. This server supports version 1.";
      case "capability_unsupported":
        return "A required Foundry capability is not supported by this server.";
    }
  }
}

export const FoundryReadiness = Schema.Struct({ ready: Schema.Boolean });
export type FoundryReadiness = typeof FoundryReadiness.Type;
