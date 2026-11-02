import * as Schema from "effect/Schema";
import { FoundryDeviceChallenge, FoundryDeviceHello } from "./foundryDevices.ts";
import { FoundryGatewayGrant } from "./foundryGateway.ts";
import { ProjectSnapshot } from "./project.ts";
export const FoundryDeviceChannelFrame = Schema.Union([
  FoundryDeviceChallenge,
  FoundryDeviceHello,
  Schema.Struct({
    type: Schema.Literal("stream-open"),
    connectionId: Schema.String,
    ticket: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
    grant: FoundryGatewayGrant,
  }),
  Schema.Struct({
    type: Schema.Literal("projects-read"),
    connectionId: Schema.String,
    requestId: Schema.String,
    grant: FoundryGatewayGrant,
  }),
  Schema.Struct({
    type: Schema.Literal("projects-result"),
    connectionId: Schema.String,
    requestId: Schema.String,
    snapshot: ProjectSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("projects-failed"),
    connectionId: Schema.String,
    requestId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    connectionId: Schema.String,
    channelGeneration: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literals(["heartbeat", "ack"]),
    connectionId: Schema.String,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ type: Schema.Literal("error"), code: Schema.String }),
]);
export type FoundryDeviceChannelFrame = typeof FoundryDeviceChannelFrame.Type;
