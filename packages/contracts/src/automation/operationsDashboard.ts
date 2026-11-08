import { TurnTokenUsage } from "../providerRuntime.ts";
import * as Schema from "effect/Schema";

export const OperationsDashboardQuery = Schema.Struct({
  op: Schema.Literal("operationsDashboard"),
  factoryId: Schema.String.check(Schema.isMinLength(1)),
  runId: Schema.optional(Schema.String),
  from: Schema.Number,
  to: Schema.Number,
});
export type OperationsDashboardQuery = typeof OperationsDashboardQuery.Type;
export const OperationsRunEvidence = Schema.Struct({
  runId: Schema.String,
  workItemId: Schema.String,
  title: Schema.String,
  state: Schema.String,
  enrolledAt: Schema.NullOr(Schema.Number),
  workerId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  retries: Schema.Number,
  failedAttempts: Schema.Number,
  archiveCursor: Schema.Number,
  pullRequests: Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Number })),
});
export type OperationsRunEvidence = typeof OperationsRunEvidence.Type;
const Period = Schema.Struct({
  from: Schema.Number,
  to: Schema.Number,
  runs: Schema.Number,
  workItems: Schema.Number,
  pullRequests: Schema.Number,
  failedRuns: Schema.Number,
  withoutPullRequest: Schema.Number,
  retries: Schema.Number,
});
const MissingMetric = Schema.Struct({
  status: Schema.Literals(["measured", "estimated", "missing", "stale"]),
  value: Schema.NullOr(Schema.Number),
  reason: Schema.String,
});
export const OperationsDashboard = Schema.Struct({
  kind: Schema.Literal("operationsDashboard"),
  generatedAt: Schema.Number,
  current: Period,
  comparison: Period,
  items: Schema.Array(OperationsRunEvidence),
  truncated: Schema.Boolean,
  unassignedTime: Schema.Number,
  cycleTime: MissingMetric,
  costs: Schema.Array(Schema.Struct({ category: Schema.Literals(["inference", "compute", "platform"]), ...MissingMetric.fields })),
  costPerPullRequest: MissingMetric,
  costCoverage: Schema.NullOr(Schema.Number),
  usageEvidence: Schema.Array(Schema.Struct({
    commandId: Schema.String,
    threadId: Schema.String,
    environmentId: Schema.String,
    sequence: Schema.Number,
    providerTurnId: Schema.String,
    usedTokens: Schema.NullOr(Schema.Number),
    turnUsage: Schema.NullOr(TurnTokenUsage),
    updatedAt: Schema.String,
  })),
  usageStatus: Schema.Literals(["measured", "missing", "stale"]),
  usageNote: Schema.String,
  costEvidence: Schema.Array(Schema.Struct({
    threadId: Schema.String,
    environmentId: Schema.String,
    providerThreadId: Schema.String,
    sequence: Schema.Number,
    amount: Schema.Number,
    currency: Schema.String,
    observedAt: Schema.String,
    attribution: Schema.Literal("thread_cumulative_unallocated"),
  })),
  usagePartial: Schema.Boolean,
  usageTruncated: Schema.Boolean,
  usageAttemptLimit: Schema.Number,
  usageEventLimit: Schema.Number,
  archiveCoverage: Schema.Array(Schema.Struct({
    commandId: Schema.String,
    cursor: Schema.Number,
    after: Schema.Number,
    loadedEvents: Schema.Number,
    sourceHead: Schema.NullOr(Schema.Number),
    nextCursor: Schema.NullOr(Schema.Number),
    status: Schema.Literals(["measured", "stale", "missing"]),
  })),
});
export type OperationsDashboard = typeof OperationsDashboard.Type;
