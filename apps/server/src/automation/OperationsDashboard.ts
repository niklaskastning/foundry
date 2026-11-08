import type { OperationsRunEvidence, OperationsDashboardQuery } from "@t3tools/contracts";
import { AutomationApplicationError, FoundryArchiveOwner, type FoundryInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Database from "./AutomationDatabase.ts";

export function summarizeOperations(items: readonly OperationsRunEvidence[], from: number, to: number) {
  const selected = items.filter((item) => item.enrolledAt !== null && item.enrolledAt >= from && item.enrolledAt < to);
  return {
    from, to, runs: selected.length,
    workItems: new Set(selected.map((item) => item.workItemId)).size,
    pullRequests: new Set(selected.flatMap((item) => item.pullRequests.map((pr) => pr.url))).size,
    failedRuns: selected.filter((item) => item.state === "failed").length,
    withoutPullRequest: selected.filter((item) => item.pullRequests.length === 0).length,
    retries: selected.reduce((total, item) => total + item.retries, 0),
  };
}
export function latestOperationsUsage(evidence: readonly import("@t3tools/contracts").OperationsDashboard["usageEvidence"][number][]) {
  const distinct = new Map<string, typeof evidence[number]>();
  for (const snapshot of evidence) {
    const key = JSON.stringify([snapshot.environmentId, snapshot.threadId, snapshot.providerTurnId]);
    const previous = distinct.get(key);
    if (!previous || snapshot.sequence > previous.sequence) distinct.set(key, snapshot);
  }
  return [...distinct.values()];
}
export class OperationsDashboard extends Context.Service<OperationsDashboard, {
  readonly query: (input: OperationsDashboardQuery, identity: { instanceId: FoundryInstanceId; operatorId: string }) => Effect.Effect<import("@t3tools/contracts").OperationsDashboard, AutomationApplicationError>;
}>()("t3/automation/OperationsDashboard") {}
const make = Effect.gen(function* () {
  const sql = yield* Database.AutomationDatabase;
  const archive = yield* ThreadArchive.ThreadArchive;
  const query = Effect.fn("OperationsDashboard.query")(function* (input: OperationsDashboardQuery, identity: { instanceId: FoundryInstanceId; operatorId: string }) {
    if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to <= input.from || input.to - input.from > 366 * 86400000)
      return yield* new AutomationApplicationError({ code: "invalid_input" });
    const rows = yield* sql<OperationsRunEvidence>`SELECT r.id AS "runId", r.work_item_id AS "workItemId", w.title,
      COALESCE(NULLIF(c.mode,'active'),d.state,r.state) AS state,
      (extract(epoch FROM d.enrolled_at)*1000)::float8 AS "enrolledAt", d.worker_id AS "workerId",
      d.binding->>'model' AS model,
      (SELECT count(*)::float8 FROM foundry_automation.step_attempts a WHERE a.run_id=r.id) AS attempts,
      (SELECT count(*)::float8 FROM foundry_automation.step_attempts a WHERE a.run_id=r.id AND a.attempt_number>0) AS retries,
      (SELECT count(*)::float8 FROM foundry_automation.step_attempts a WHERE a.run_id=r.id AND a.state='failed') AS "failedAttempts",
      COALESCE((SELECT sum(a.archive_cursor)::float8 FROM foundry_automation.step_attempts a WHERE a.run_id=r.id),0) AS "archiveCursor",
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('url',p.result->>'url','number',(p.result->>'number')::integer)) FROM foundry_automation.publish_operations p WHERE p.run_id=r.id AND p.state='published' AND p.result->>'url' IS NOT NULL),'[]'::jsonb) AS "pullRequests"
      FROM foundry_automation.runs r JOIN foundry_automation.work_items w ON w.id=r.work_item_id AND w.factory_id=r.factory_id
      LEFT JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id LEFT JOIN foundry_automation.run_controls c ON c.run_id=r.id
      WHERE r.factory_id=${input.factoryId} AND (${input.runId ?? null}::text IS NULL OR r.id=${input.runId ?? null})
      AND (d.run_id IS NULL OR (d.binding->'identity'->>'instanceId'=${identity.instanceId} AND d.binding->'identity'->>'operatorId'=${identity.operatorId}))
      AND (d.enrolled_at IS NULL OR (d.enrolled_at>=to_timestamp(${(2 * input.from - input.to) / 1000}) AND d.enrolled_at<to_timestamp(${input.to / 1000})))
      ORDER BY d.enrolled_at DESC NULLS LAST,r.id LIMIT 1001`;
    const usageEvidence: Array<import("@t3tools/contracts").OperationsDashboard["usageEvidence"][number]> = [];
    const archiveCoverage: Array<import("@t3tools/contracts").OperationsDashboard["archiveCoverage"][number]> = [];
    let usageTruncated = false;
    if (input.runId && rows.length) {
      const attempts = yield* sql<{ commandId: string; owner: unknown; cursor: number }>`SELECT a.command_id AS "commandId",jsonb_build_object('threadId',a.receipt->'receipt'->>'threadId','environmentId',COALESCE(a.worker_binding->'identity'->>'environmentId',d.binding->'identity'->>'environmentId')) AS owner,a.archive_cursor AS cursor FROM foundry_automation.step_attempts a JOIN foundry_automation.dispatch_runs d ON d.run_id=a.run_id WHERE a.run_id=${input.runId} AND a.receipt IS NOT NULL ORDER BY a.ordinal DESC,a.attempt_number DESC LIMIT 6`;
      usageTruncated = attempts.length > 5;
      for (const attempt of attempts.slice(0, 5)) {
        const owner = Schema.decodeUnknownOption(FoundryArchiveOwner)(attempt.owner);
        const after = Math.max(0, attempt.cursor - 50);
        if (Option.isNone(owner)) {
          archiveCoverage.push({ commandId: attempt.commandId, cursor: attempt.cursor, after, loadedEvents: 0, sourceHead: null, nextCursor: null, status: "missing" });
          continue;
        }
        const page = yield* archive.read(identity, { owner: owner.value, after, limit: 50 }).pipe(Effect.option);
        if (Option.isNone(page)) {
          archiveCoverage.push({ commandId: attempt.commandId, cursor: attempt.cursor, after, loadedEvents: 0, sourceHead: null, nextCursor: null, status: "missing" });
          continue;
        }
        usageTruncated ||= after > 0 || page.value.nextCursor !== null;
        archiveCoverage.push({ commandId: attempt.commandId, cursor: attempt.cursor, after, loadedEvents: page.value.events.length, sourceHead: page.value.sourceHead, nextCursor: page.value.nextCursor, status: page.value.complete ? "measured" : "stale" });
        const turns = new Map<string, typeof page.value.events[number]>();
        for (const event of page.value.events) {
          if (event.event.type === "provider-turn.updated") turns.set(event.event.payload.id, event);
        }
        for (const event of turns.values()) {
          if (event.event.type !== "provider-turn.updated" || !event.event.payload.tokenUsage) continue;
          const usage = event.event.payload.tokenUsage;
          usageEvidence.push({ commandId: attempt.commandId, threadId: owner.value.threadId, environmentId: owner.value.environmentId, sequence: event.sequence, providerTurnId: event.event.payload.id, usedTokens: usage.usedTokens, updatedAt: usage.updatedAt });
        }
      }
    }
    const missing = (reason: string) => ({ status: "missing" as const, value: null, reason });
    const items = rows.slice(0, 1000);
    return {
      kind: "operationsDashboard" as const, generatedAt: yield* Clock.currentTimeMillis,
      current: summarizeOperations(items, input.from, input.to),
      comparison: summarizeOperations(items, 2 * input.from - input.to, input.from),
      items, truncated: rows.length > 1000, unassignedTime: items.filter((item) => item.enrolledAt === null).length,
      cycleTime: missing("Run completion timestamps are not persisted in Automation. Enrollment is not completion; cycle time is unavailable."),
      costs: (["inference", "compute", "platform"] as const).map((category) => ({ category, ...missing("No monetary evidence is persisted for this category. Archive cursor counts are not usage or money.") })),
      costPerPullRequest: missing("Requires complete, currency-compatible cost evidence for every selected run, including retries, failed work and work without a PR. Denominator: distinct published PR URLs in the enrollment cohort. Shared infrastructure has no allocation evidence."),
      costCoverage: null,
      usageEvidence: latestOperationsUsage(usageEvidence),
      usagePartial: true,
      usageTruncated,
      usageAttemptLimit: 5,
      usageEventLimit: 50,
      archiveCoverage,
      usageStatus: usageEvidence.length ? (archiveCoverage.some((page) => page.status !== "measured") ? "stale" as const : "measured" as const) : "missing" as const,
      usageNote: "Run drilldown reads at most five attempts and 50 archived events per attempt. Latest provider-turn snapshots within each page are shown separately, never summed as billable usage. This is partial evidence, not a complete run total or monetary cost. No usage evidence does not mean zero usage.",
    };
  }, Effect.mapError((cause) => cause instanceof AutomationApplicationError ? cause : new AutomationApplicationError({ code: "unavailable" })));
  return OperationsDashboard.of({ query });
});
export const layer = Layer.effect(OperationsDashboard, make);
