import { FoundryUI } from "../../foundry/FoundryUI";
import { Link } from "@tanstack/react-router";
import { openWorkspaceRun } from "../../foundry/workspaceSearch";
import type { EnvironmentId } from "@t3tools/contracts";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { runStates } from "../../foundry/workspaceSearch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { runStatusVariant } from "./runTopology";
import { ListFilters } from "./ListFilters";
import { useAutomationQuery } from "./useAutomationQuery";

export function RunList({
  environmentId,
  factoryId,
  workItemId,
  onOpen,
  compact = false,
}: {
  environmentId: EnvironmentId;
  factoryId?: string;
  workItemId?: string;
  compact?: boolean;
  onOpen: (factoryId: string, runId: string) => void;
}) {
  const navigation = useWorkspaceNavigation();
  const after = compact ? undefined : navigation.search.after;
  const filterFactory = factoryId ?? navigation.search.filterFactory ?? "";
  const state = compact ? "all" : (navigation.search.runState ?? "all");
  const setAfter = (after?: string) => navigation.update({ after });
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "runs",
    limit: compact ? 5 : 20,
    recent: true,
    ...(filterFactory ? { factoryId: filterFactory } : {}),
    ...(state !== "all" ? { state } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(after ? { after } : {}),
  });
  return (
    <section className="space-y-3" aria-label="Runs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoundryUI.Heading>{compact ? "Recent runs" : "Runs"}</FoundryUI.Heading>
          {!compact && !workItemId ? (
            <p className="text-sm text-muted-foreground">
              Newest queued runs first. Follow execution, review results and resolve blocked work.
            </p>
          ) : null}
        </div>
        <Button variant="outline" onClick={refresh}>
          Refresh runs
        </Button>
      </div>
      {!compact && !workItemId ? (
        <ListFilters
          environmentId={environmentId}
          factoryId={filterFactory}
          {...(!factoryId
            ? {
                onFactoryChange: (value: string) => {
                  navigation.update({ filterFactory: value, after: undefined });
                },
              }
            : {})}
          state={state}
          states={runStates}
          onStateChange={(value) => {
            navigation.update({ runState: value, after: undefined });
          }}
        />
      ) : null}
      {error ? <FoundryUI.Notice>{error}</FoundryUI.Notice> : null}
      {loading && !result ? <p role="status">Loading runs…</p> : null}
      {result?.kind === "runs" ? (
        <>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {result.items.map((run) => (
              <li
                key={run.id}
                className="relative flex flex-wrap items-center justify-between gap-2 px-3 py-3 hover:bg-accent/40 sm:px-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="break-words text-sm font-medium">
                      <Link
                        to="/foundry"
                        search={openWorkspaceRun(navigation.search, run.factoryId, run.id)}
                        className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                      >
                        {run.workItemTitle ?? "Work item"}
                      </Link>
                    </p>
                    <Badge variant={runStatusVariant(run.state)}>
                      {run.state.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {!factoryId ? (
                      <span>Factory: {run.factoryName ?? "Name unavailable"}</span>
                    ) : null}
                    <span>Run {run.id.slice(0, 8)}</span>
                    {run.workflowName ? <span>{run.workflowName}</span> : null}
                    <span>{run.repository}</span>
                    {run.enrolledAt ? (
                      <time dateTime={run.enrolledAt}>
                        Queued{" "}
                        {new Date(run.enrolledAt).toLocaleString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </time>
                    ) : null}
                  </div>
                  {run.pullRequests?.map((url) => (
                    <a
                      key={url}
                      className="relative z-10 block text-sm underline"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Review pull request
                    </a>
                  ))}
                  {run.state === "succeeded" ||
                  run.state === "cancelled" ||
                  run.state === "failed" ? (
                    <p className="text-xs text-muted-foreground">
                      Completion time is not recorded in this list. Open the run to review results.
                    </p>
                  ) : null}
                </div>
                <Button variant="ghost" onClick={() => onOpen(run.factoryId, run.id)}>
                  Open run
                </Button>
              </li>
            ))}
          </ul>
          {result.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs match this selection. Start a workflow from a work item, or adjust the
              filters.
            </p>
          ) : null}
          {!compact ? (
            <div className="flex gap-2">
              <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
                First page
              </Button>
              <Button
                variant="outline"
                disabled={!result.next}
                onClick={() => setAfter(result.next ?? undefined)}
              >
                Next runs
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
