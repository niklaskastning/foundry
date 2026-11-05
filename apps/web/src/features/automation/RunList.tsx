import type { EnvironmentId } from "@t3tools/contracts";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { runStates } from "../../foundry/workspaceSearch";
import { Button } from "../../components/ui/button";
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{compact ? "Recent runs & results" : "Runs"}</h2>
        <Button variant="outline" onClick={refresh}>
          Refresh runs
        </Button>
      </div>
      {!compact ? (
        <ListFilters
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
      {loading ? <p role="status">Loading runs…</p> : null}
      {result?.kind === "runs" ? (
        <>
          <ul className="divide-y rounded-lg border">
            {result.items.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <p className="text-sm font-medium">{run.workItemTitle ?? "Work item"}</p>
                  <p className="text-xs text-muted-foreground">
                    {run.state.replaceAll("_", " ")} · {run.repository}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => onOpen(run.factoryId, run.id)}>
                  Open run
                </Button>
              </li>
            ))}
          </ul>
          {result.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs match this selection.</p>
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
