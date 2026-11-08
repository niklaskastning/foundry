import { describe, expect, it } from "vitest";
import { summarizeOperations, latestOperationsUsage } from "./OperationsDashboard.ts";
import type { OperationsRunEvidence } from "@t3tools/contracts";

const run = (changes: Partial<OperationsRunEvidence>): OperationsRunEvidence => ({
  runId: "run", workItemId: "work", title: "Work", state: "failed", enrolledAt: 10,
  workerId: null, model: null, attempts: 3, retries: 2, failedAttempts: 1, archiveCursor: 0,
  pullRequests: [], ...changes,
});
describe("operations enrollment cohorts", () => {
  it("keeps retry and failed work without PRs and deduplicates shared PR evidence", () => {
    const pr = { url: "https://github.com/example/repo/pull/1", number: 1 };
    const rows = [run({}), run({ runId: "second", state: "succeeded", retries: 0, pullRequests: [pr, pr] }), run({ runId: "third", state: "succeeded", retries: 0, pullRequests: [pr] })];
    expect(summarizeOperations(rows, 10, 20)).toEqual({ from: 10, to: 20, runs: 3, workItems: 1, pullRequests: 1, failedRuns: 1, withoutPullRequest: 1, retries: 2 });
  });
  it("uses disjoint half-open periods and never assigns unknown timestamps", () => {
    const rows = [run({ enrolledAt: null }), run({ enrolledAt: 0 }), run({ enrolledAt: 10 }), run({ enrolledAt: 20 })];
    expect(summarizeOperations(rows, 0, 10).runs).toBe(1);
    expect(summarizeOperations(rows, 10, 20).runs).toBe(1);
    expect(summarizeOperations([], 10, 20).pullRequests).toBe(0);
  });
});

it("deduplicates reused threads and keeps latest snapshots instead of summing cumulative usage", () => {
  const base = { commandId: "first", threadId: "thread", environmentId: "worker", sequence: 2, providerTurnId: "turn", usedTokens: 100, turnUsage: null, updatedAt: "2026-11-08T00:00:00Z" };
  const latest = { ...base, commandId: "retry", sequence: 3, usedTokens: 150 };
  expect(latestOperationsUsage([base, latest, base])).toEqual([latest]);
  expect(latestOperationsUsage([base, { ...base, environmentId: "other" }])).toHaveLength(2);
  expect(latestOperationsUsage([])).toEqual([]);
});
