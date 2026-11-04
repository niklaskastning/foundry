import { useState } from "react";
import type { EnvironmentId, AutomationRun } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { ListFilters } from "./ListFilters";
import { useAutomationQuery } from "./useAutomationQuery";

export function RunList({
  environmentId,
  factoryId,
  workItemId,
  onOpen,
}: {
  environmentId: EnvironmentId;
  factoryId?: string;
  workItemId?: string;
  onOpen: (factoryId: string, runId: string) => void;
}) {
  const [after, setAfter] = useState<string>();
  const [filterFactory, setFilterFactory] = useState(factoryId ?? "");
  const [state, setState] = useState<AutomationRun["state"] | "all">("all");
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "runs",
    limit: 20,
    ...(filterFactory ? { factoryId: filterFactory } : {}),
    ...(state !== "all" ? { state } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(after ? { after } : {}),
  });
  return (
    <section className="space-y-3" aria-label="Runs">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Runs</h2>
        <Button variant="outline" onClick={refresh}>
          Refresh runs
        </Button>
      </div>
      <ListFilters
        factoryId={filterFactory}
        {...(!factoryId
          ? {
              onFactoryChange: (value: string) => {
                setFilterFactory(value);
                setAfter(undefined);
              },
            }
          : {})}
        state={state}
        states={[
          "all",
          "pending",
          "running",
          "waiting",
          "paused",
          "cancel_requested",
          "cancelled",
          "failed",
          "succeeded",
        ]}
        onStateChange={(value) => {
          setState(value);
          setAfter(undefined);
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">Loading runs…</p> : null}
      {result?.kind === "runs" ? (
        <>
          <ul className="divide-y rounded-lg border">
            {result.items.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <p className="text-sm font-medium">{run.workItemId}</p>
                  <p className="text-xs text-muted-foreground">
                    {run.state} · {run.repository} · {run.revision}
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
        </>
      ) : null}
    </section>
  );
}
