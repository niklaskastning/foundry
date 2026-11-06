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
    ...(compact ? { recent: true } : {}),
    ...(filterFactory ? { factoryId: filterFactory } : {}),
    ...(state !== "all" ? { state } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(after ? { after } : {}),
  });
  return (
    <section className="space-y-3" aria-label="Runs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{compact ? "Recent runs" : "Runs"}</h2>
          {!compact ? (
            <p className="text-sm text-muted-foreground">
              Follow execution, review results and resolve blocked work.
            </p>
          ) : null}
        </div>
        <Button variant="outline" onClick={refresh}>
          Refresh runs
        </Button>
      </div>
      {!compact ? (
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
      {error ? <p role="alert">{error}</p> : null}
      {loading && !result ? <p role="status">Loading runs…</p> : null}
      {result?.kind === "runs" ? (
        <>
          <ul className="divide-y rounded-lg border bg-card">
            {result.items.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="break-words text-sm font-medium">
                      {run.workItemTitle ?? "Work item"}
                    </p>
                    <Badge variant={runStatusVariant(run.state)}>
                      {run.state.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
