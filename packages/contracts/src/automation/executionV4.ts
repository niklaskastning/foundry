import * as Schema from "effect/Schema";
import { FactoryV4Node } from "./definitionV4.ts";

export const FactoryV4Checkpoint = Schema.Struct({
  commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  commandId: Schema.String,
  generation: Schema.Int,
  workerId: Schema.String,
});
export type FactoryV4Checkpoint = typeof FactoryV4Checkpoint.Type;
export const FactoryV4NodeState = Schema.Struct({
  path: Schema.String,
  scope: Schema.String,
  definition: FactoryV4Node,
  status: Schema.Literals([
    "pending",
    "ready",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "skipped",
    "blocked",
    "cancelled",
  ]),
  ordinal: Schema.optional(Schema.Int),
  condition: Schema.optional(Schema.Boolean),
  until: Schema.optional(Schema.Boolean),
  iteration: Schema.optional(Schema.Int),
  carry: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  previous: Schema.optional(Schema.Json),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  base: Schema.String,
  checkpoint: Schema.optional(FactoryV4Checkpoint),
  workspaceCheckpoint: Schema.optional(FactoryV4Checkpoint),
  output: Schema.optional(Schema.Json),
  reason: Schema.optional(Schema.String),
  cancelRequested: Schema.optional(Schema.Boolean),
  approvalPath: Schema.optional(Schema.String),
});
export type FactoryV4NodeState = typeof FactoryV4NodeState.Type;
export const FactoryV4RunState = Schema.Struct({
  nodes: Schema.Array(FactoryV4NodeState).check(Schema.isMaxLength(20000)),
  startedAgentExecutions: Schema.Int,
  status: Schema.Literals(["running", "waiting", "succeeded", "failed"]),
  reason: Schema.optional(Schema.String),
  inputs: Schema.Record(Schema.String, Schema.Json),
});
export type FactoryV4RunState = typeof FactoryV4RunState.Type;
