import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { FoundryInstanceId } from "./foundry.ts";

export const FoundryDeviceId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("FoundryDeviceId"),
);
export type FoundryDeviceId = typeof FoundryDeviceId.Type;
export const FoundryDevicePublicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const FoundryEnrollment = Schema.Struct({
  protocolVersion: Schema.Literal("1"),
  instanceId: FoundryInstanceId,
  origin: Schema.String,
  environmentId: EnvironmentId,
  publicKey: FoundryDevicePublicKey,
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  expiresAt: Schema.Number,
});
export type FoundryEnrollment = typeof FoundryEnrollment.Type;
export const FoundryEnrollmentRequest = Schema.Struct({
  enrollment: FoundryEnrollment,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundryEnrollmentRequest = typeof FoundryEnrollmentRequest.Type;
export const FoundryDevice = Schema.Struct({
  deviceId: FoundryDeviceId,
  instanceId: FoundryInstanceId,
  environmentId: EnvironmentId,
  publicKey: FoundryDevicePublicKey,
  generation: Schema.Number,
  revoked: Schema.Boolean,
});
export type FoundryDevice = typeof FoundryDevice.Type;

export const FoundryDeviceChallenge = Schema.Struct({
  type: Schema.Literal("challenge"),
  protocolVersion: Schema.Literal("1"),
  instanceId: FoundryInstanceId,
  origin: Schema.String,
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export type FoundryDeviceChallenge = typeof FoundryDeviceChallenge.Type;
export const FoundryDeviceHello = Schema.Struct({
  httpRead: Schema.optionalKey(Schema.Boolean),
  rpcStream: Schema.optionalKey(Schema.Boolean),
  type: Schema.Literal("hello"),
  deviceId: FoundryDeviceId,
  instanceId: FoundryInstanceId,
  environmentId: EnvironmentId,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundryDeviceHello = typeof FoundryDeviceHello.Type;

export class FoundryDeviceError extends Schema.TaggedError<FoundryDeviceError>()(
  "FoundryDeviceError",
  {
    code: Schema.Literals([
      "invalid_enrollment",
      "expired_enrollment",
      "invalid_proof",
      "conflict",
      "revoked",
      "not_found",
      "unavailable",
      "configuration",
      "channel_superseded",
      "channel_protocol",
    ]),
  },
) {
  override get message(): string {
    return `Foundry device operation rejected (${this.code}).`;
  }
}
