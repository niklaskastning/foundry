import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FoundryInstanceId } from "@t3tools/contracts";
import * as Database from "./AutomationDatabase.ts";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import {
  OperationsDashboard,
  layer,
  summarizeOperations,
  latestOperationsUsage,
} from "./OperationsDashboard.ts";
import type { OperationsRunEvidence } from "@t3tools/contracts";

const unused = (): never => {
  throw new Error("Invalid periods must not execute SQL");
};

const run = (changes: Partial<OperationsRunEvidence>): OperationsRunEvidence => ({
  runId: "run",
  workItemId: "work",
  title: "Work",
  state: "failed",
  enrolledAt: 10,
  workerId: null,
  model: null,
  attempts: 3,
  retries: 2,
  failedAttempts: 1,
  archiveCursor: 0,
  pullRequests: [],
  ...changes,
});
describe("operations enrollment cohorts", () => {
  it("keeps retry and failed work without PRs and deduplicates shared PR evidence", () => {
    const pr = { url: "https://github.com/example/repo/pull/1", number: 1 };
    const rows = [
      run({}),
      run({ runId: "second", state: "succeeded", retries: 0, pullRequests: [pr, pr] }),
      run({ runId: "third", state: "succeeded", retries: 0, pullRequests: [pr] }),
    ];
    expect(summarizeOperations(rows, 10, 20)).toEqual({
      from: 10,
      to: 20,
      runs: 3,
      workItems: 1,
      pullRequests: 1,
      failedRuns: 1,
      withoutPullRequest: 1,
      retries: 2,
    });
  });
  it("uses disjoint half-open periods and never assigns unknown timestamps", () => {
    const rows = [
      run({ enrolledAt: null }),
      run({ enrolledAt: 0 }),
      run({ enrolledAt: 10 }),
      run({ enrolledAt: 20 }),
    ];
    expect(summarizeOperations(rows, 0, 10).runs).toBe(1);
    expect(summarizeOperations(rows, 10, 20).runs).toBe(1);
    expect(summarizeOperations([], 10, 20).pullRequests).toBe(0);
  });
});

it("deduplicates reused threads and keeps latest snapshots instead of summing cumulative usage", () => {
  const base = {
    commandId: "first",
    threadId: "thread",
    environmentId: "worker",
    sequence: 2,
    providerTurnId: "turn",
    usedTokens: 100,
    turnUsage: null,
    updatedAt: "2026-11-08T00:00:00Z",
  };
  const latest = { ...base, commandId: "retry", sequence: 3, usedTokens: 150 };
  expect(latestOperationsUsage([base, latest, base])).toEqual([latest]);
  expect(latestOperationsUsage([base, { ...base, environmentId: "other" }])).toHaveLength(2);
  expect(latestOperationsUsage([])).toEqual([]);
  const boundaries = new Map([["first", { cursor: 2, providerTurnId: "turn" }]]);
  expect(
    latestOperationsUsage(
      [base, { ...base, sequence: 4, usedTokens: 900 }, { ...base, providerTurnId: "later-turn" }],
      boundaries,
    ),
  ).toEqual([base]);
  expect(
    latestOperationsUsage([base], new Map([["first", { cursor: 2, providerTurnId: null }]])),
  ).toEqual([]);
});

it.effect("rejects invalid or oversized periods before reading SQL or archives", () =>
  Effect.gen(function* () {
    const dashboard = yield* OperationsDashboard;
    for (const [from, to] of [
      [10, 10],
      [20, 10],
      [0, Infinity],
      [NaN, 10],
      [0, 367 * 86400000],
    ] as const) {
      const error = yield* dashboard
        .query(
          { op: "operationsDashboard", factoryId: "factory", from, to },
          {
            instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
            operatorId: "operator",
          },
        )
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_input");
    }
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Database.AutomationDatabase)({
              "~effect/sql/SqlClient": "~effect/sql/SqlClient",
              "~@effect/sql-pg/PgClient": "~@effect/sql-pg/PgClient",
              config: {},
              literal: unused,
              in: unused,
              insert: unused,
              update: unused,
              updateValues: unused,
              and: unused,
              or: unused,
              csv: unused,
              join: unused,
              onDialect: unused,
              onDialectOrElse: unused,
              json: unused,
              listen: unused,
              withoutTransforms: unused,
            }),
            Layer.mock(ThreadArchive.ThreadArchive)({}),
          ),
        ),
      ),
    ),
  ),
);
