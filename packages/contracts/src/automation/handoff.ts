import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, NonNegativeInt } from "../baseSchemas.ts";
import {
  FoundryHandoffMode,
  FoundryWorkerHandoffReceipt,
  FoundryWorkerHandoffResult,
} from "../foundryHandoff.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const AutomationHandoffCommand = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("takeOver"),
    commandId: Key,
    id: Key,
    factoryId: Key,
    runId: Key,
    expectedRevision: NonNegativeInt,
    sourceCommandId: Key,
    mode: FoundryHandoffMode,
  }),
  Schema.Struct({
    op: Schema.Literal("returnHandoff"),
    commandId: Key,
    factoryId: Key,
    handoffId: Key,
    expectedGeneration: NonNegativeInt,
    expectedBaseCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    tests: Schema.String.check(Schema.isMaxLength(20_000)),
    openPoints: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
  Schema.Struct({
    op: Schema.Literal("reopenHandoff"),
    commandId: Key,
    factoryId: Key,
    handoffId: Key,
    expectedGeneration: NonNegativeInt,
  }),
]);
export type AutomationHandoffCommand = typeof AutomationHandoffCommand.Type;
export const AutomationHandoff = Schema.Struct({
  pendingCommands: Schema.Array(AutomationHandoffCommand),
  id: Key,
  factoryId: Key,
  workItemId: Key,
  runId: Key,
  sourceCommandId: Key,
  environmentId: EnvironmentId,
  generation: NonNegativeInt,
  baseRevision: Key,
  state: Schema.Literals(["opening", "open", "returning", "returned"]),
  mode: FoundryHandoffMode,
  receipt: Schema.NullOr(FoundryWorkerHandoffReceipt),
  result: Schema.NullOr(FoundryWorkerHandoffResult),
  continuationRunId: Schema.NullOr(Key),
});
export type AutomationHandoff = typeof AutomationHandoff.Type;
export const AutomationHandoffQuery = Schema.Union([
  Schema.Struct({ op: Schema.Literal("handoffs"), factoryId: Key, workItemId: Key }),
  Schema.Struct({
    op: Schema.Literal("threadHandoff"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
]);
export type AutomationHandoffQuery = typeof AutomationHandoffQuery.Type;
