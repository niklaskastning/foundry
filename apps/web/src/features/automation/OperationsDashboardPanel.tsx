import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { useAutomationQuery } from "./useAutomationQuery";

export function OperationsDashboardPanel({
  environmentId,
  factoryId,
  runId,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId?: string;
  onOpenRun?: (factoryId: string, runId: string) => void;
}) {
  const [selection, setSelection] = useState<{ factoryId: string; runId: string } | null>(null);
  const selectedRunId = selection?.factoryId === factoryId ? selection.runId : runId;
  const [days, setDays] = useState(7);
  const [end, setEnd] = useState(() => Date.now());
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "operationsDashboard",
    factoryId,
    ...(selectedRunId ? { runId: selectedRunId } : {}),
    from: end - days * 86400000,
    to: end,
  });
  const data = result?.kind === "operationsDashboard" ? result : null;
  return (
    <section className="min-w-0 space-y-4 wrap-anywhere" aria-label="Operations dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Operations</h2>
        <div className="flex flex-wrap gap-2">
          {selection ? (
            <Button variant="outline" onClick={() => setSelection(null)}>
              Back to operations
            </Button>
          ) : null}
          {[1, 7, 30].map((period) => (
            <Button
              key={period}
              variant={days === period ? "default" : "outline"}
              onClick={() => {
                setDays(period);
                setEnd(Date.now());
              }}
            >
              {period} {period === 1 ? "day" : "days"}
            </Button>
          ))}
          <Button
            variant="outline"
            onClick={() => {
              setEnd(Date.now());
              refresh();
            }}
          >
            Refresh operations
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Runs grouped by enrollment time, compared with the preceding equal period. Status and PR
        evidence reflect the latest persisted state, not historical snapshots. Refresh to update.
      </p>
      {loading ? <p role="status">Loading operations…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {data ? (
        <>
          <p className="text-sm">
            {new Date(data.current.from).toLocaleString()} –{" "}
            {new Date(data.current.to).toLocaleString()}. Retrieved{" "}
            {new Date(data.generatedAt).toLocaleString()}.
          </p>
          {data.truncated ? (
            <p role="alert">
              Limited to 1,000 runs. Counts describe this sample; narrow the period for complete
              totals.
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="text-left">Enrollment cohorts</caption>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Selected period</th>
                  <th>Previous period</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["runs", "Runs"],
                    ["workItems", "Work items"],
                    ["pullRequests", "Distinct PRs"],
                    ["failedRuns", "Failed runs"],
                    ["withoutPullRequest", "Runs without a PR"],
                    ["retries", "Retry attempts"],
                  ] as const
                ).map(([key, label]) => (
                  <tr key={key}>
                    <th>{label}</th>
                    <td>{data.current[key]}</td>
                    <td>{data.comparison[key]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            {data.unassignedTime} runs have no enrollment timestamp and are excluded from both
            periods. Retries remain attributed to their original run. Failed runs and work without a
            PR remain in the cohort.
          </p>
          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-medium">Cost availability</h3>
            <p className="text-sm text-muted-foreground">
              Unavailable categories are excluded from totals. Expand methodology below for evidence
              limits.
            </p>
            {data.costs.map((cost) => (
              <p key={cost.category} className="text-sm">
                <Badge variant="outline">{cost.status}</Badge> {cost.category}:{" "}
                {cost.value ?? "Not available"}.
              </p>
            ))}
            <p className="text-sm">
              Cost per PR: {data.costPerPullRequest.value ?? "Unknown"}.{" "}
              {data.costPerPullRequest.reason}
            </p>
            <p className="text-sm">
              Cost coverage:{" "}
              {data.costCoverage === null ? "Unknown; no cost source" : `${data.costCoverage}%`}.
            </p>
            <p className="text-sm">
              Cycle time: {data.cycleTime.value ?? "Unknown"}. {data.cycleTime.reason}
            </p>
          </div>
          <details>
            <summary>Cost methodology and archived usage evidence</summary>
            {data.costs.map((cost) => (
              <p key={cost.category} className="text-sm">
                {cost.category}: {cost.reason}
              </p>
            ))}
            <h3 className="font-medium">Provider cost snapshots</h3>
            <p className="text-sm">
              Cumulative provider-thread amounts, measured as reported. These may span multiple runs
              or periods; they are unallocated and excluded from category totals and cost per PR.
            </p>
            <ul>
              {data.costEvidence.map((cost) => (
                <li
                  key={`${cost.environmentId}:${cost.threadId}:${cost.providerThreadId}`}
                  className="text-sm"
                >
                  {cost.amount} {cost.currency} · {cost.status} · {cost.observedAt} · Thread{" "}
                  {cost.threadId} · Provider thread {cost.providerThreadId} · Archive event{" "}
                  {cost.sequence}
                </li>
              ))}
            </ul>
            {!data.costEvidence.length ? (
              <p className="text-sm">No provider cost evidence loaded; amount unknown.</p>
            ) : null}
            <h3 className="font-medium">Archived usage evidence</h3>
            {!selectedRunId ? (
              <p className="text-sm">Select a work item below to inspect its run usage evidence.</p>
            ) : null}
            <p className="text-sm">
              <Badge variant="outline">{data.usageStatus}</Badge> {data.usageNote}
            </p>
            <p className="text-sm">
              Coverage: partial evidence,{" "}
              {data.usageTruncated ? "truncated" : "no additional truncation detected"}. Limit{" "}
              {data.usageAttemptLimit} attempts × {data.usageEventLimit} events. These pages are not
              run totals.
            </p>
            <ul>
              {data.archiveCoverage.map((page) => (
                <li key={page.commandId} className="text-xs">
                  Attempt {page.commandId}: {page.status}, persisted cursor {page.cursor}, after{" "}
                  {page.after}, {page.loadedEvents} loaded events, source head{" "}
                  {page.sourceHead ?? "Unknown"}, next cursor {page.nextCursor ?? "None"}
                </li>
              ))}
            </ul>
            <ul>
              {data.usageEvidence.map((usage) => (
                <li key={`${usage.commandId}:${usage.providerTurnId}`} className="text-sm">
                  {usage.usedTokens ?? "Unknown"} reported context tokens · {usage.updatedAt} · Turn{" "}
                  {usage.providerTurnId} · Thread {usage.threadId} · Environment{" "}
                  {usage.environmentId} · Archive event {usage.sequence} · Main agent turn usage:{" "}
                  {usage.turnUsage?.usageStatus ?? "unavailable"}, input{" "}
                  {usage.turnUsage?.inputTokens ?? "Unknown"}, output{" "}
                  {usage.turnUsage?.outputTokens ?? "Unknown"}, subagents{" "}
                  {usage.turnUsage
                    ? usage.turnUsage.hasSubagents
                      ? "excluded"
                      : "none reported"
                    : "unknown"}
                </li>
              ))}
            </ul>
          </details>
          <h3 className="font-medium">Run evidence and activity</h3>
          <p className="text-sm text-muted-foreground">
            Enrollment time is the last available activity timestamp here. Current state does not
            establish recent agent activity. Archive cursors count persisted events, not tokens.
          </p>
          <ul className="divide-y rounded-lg border">
            {data.items.map((item) => (
              <li key={item.runId} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="grid min-w-0 max-w-full grid-cols-1">
                    <Button
                      variant="ghost"
                      onClick={() => setSelection({ factoryId, runId: item.runId })}
                    >
                      <span className="truncate">{item.title}</span>
                    </Button>
                  </div>
                  <Badge variant="outline">{item.state}</Badge>
                  {onOpenRun ? (
                    <Button variant="ghost" onClick={() => onOpenRun(factoryId, item.runId)}>
                      Open run evidence
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Work {item.workItemId} · Run {item.runId} · Worker {item.workerId ?? "Unknown"} ·
                  Model {item.model ?? "Unknown"}
                </p>
                <p className="text-sm">
                  Enrolled{" "}
                  {item.enrolledAt === null
                    ? "Unknown"
                    : new Date(item.enrolledAt).toLocaleString()}{" "}
                  · {item.attempts} attempts · {item.retries} retries · {item.failedAttempts} failed
                  attempts · {item.archiveCursor} archived events
                </p>
                {item.pullRequests.length ? (
                  item.pullRequests.map((pr) => (
                    <a
                      key={pr.url}
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm underline"
                    >
                      PR #{pr.number}
                    </a>
                  ))
                ) : (
                  <p className="text-sm">
                    No published PR evidence. The run may still be active, failed, cancelled, or may
                    not include publishing.
                  </p>
                )}
              </li>
            ))}
          </ul>
          {!data.items.length ? <p>No enrolled work in these periods.</p> : null}
        </>
      ) : null}
    </section>
  );
}
