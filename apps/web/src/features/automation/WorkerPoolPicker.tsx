import { FoundryUI } from "../../foundry/FoundryUI";
import { useState } from "react";
import { FoundryDeviceId, type EnvironmentId, type ManualStart } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useAutomationQuery } from "./useAutomationQuery";

type Workers = NonNullable<ManualStart["workers"]>;
export function WorkerPoolPicker({
  environmentId,
  workers,
  onChange,
}: {
  environmentId: EnvironmentId;
  workers: Workers | undefined;
  onChange: (workers: Workers | undefined) => void;
}) {
  const [deviceId, setDeviceId] = useState<string>();
  const query = useAutomationQuery(environmentId, {
    op: "workerBinding",
    ...(deviceId ? { deviceId: FoundryDeviceId.make(deviceId) } : {}),
  });
  const target = query.result?.kind === "workerBinding" ? query.result : null;
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Authorized worker pool">
      <div>
        <h3 className="text-sm font-medium">Worker targets</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Use the configured worker, or explicitly choose up to eight worker projects for this run.
          Selection grants no new access.
        </p>
      </div>
      {workers?.length ? (
        <ul className="space-y-2">
          {workers.map((worker) => (
            <li
              key={`${worker.deviceId}:${worker.projectId}`}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="min-w-0 break-all">
                {worker.environmentId} · Project {worker.projectId}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = workers.filter((entry) => entry !== worker);
                  onChange(next.length ? next : undefined);
                }}
              >
                Remove target
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">Configured default worker</p>
      )}
      {query.error ? (
        <div className="space-y-2">
          <FoundryUI.Notice className="text-sm">
            Worker choices unavailable: {query.error}
          </FoundryUI.Notice>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={query.refresh}>
              Retry worker
            </Button>
            {deviceId ? (
              <Button size="sm" variant="outline" onClick={() => setDeviceId(undefined)}>
                Choose default worker
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {query.loading ? (
        <p role="status" className="text-sm">
          Loading authorized worker projects…
        </p>
      ) : null}
      {target?.workers ? (
        <>
          <Select
            value={deviceId ?? target.deviceId}
            onValueChange={(value) => {
              if (value !== null) setDeviceId(value);
            }}
          >
            <SelectTrigger aria-label="Worker for target pool">
              <SelectValue>{target.environmentId}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {target.workers.map((worker) => (
                <SelectItem key={worker.deviceId} value={worker.deviceId}>
                  {worker.environmentId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {target.paused
              ? "New dispatch is paused"
              : target.status.providerReady
                ? "Provider ready"
                : target.status.providerState}
            {target.status.free != null && target.status.capacity != null
              ? ` · ${target.status.free} of ${target.status.capacity} slots free`
              : " · Capacity unknown"}
          </p>
          <div className="flex flex-wrap gap-2">
            {target.projects.map((project) => (
              <Button
                key={project.id}
                size="sm"
                variant="outline"
                disabled={
                  query.loading ||
                  (workers?.length ?? 0) >= 8 ||
                  workers?.some(
                    (worker) =>
                      worker.deviceId === target.deviceId && worker.projectId === project.id,
                  )
                }
                onClick={() =>
                  onChange([
                    ...(workers ?? []),
                    {
                      deviceId: target.deviceId,
                      environmentId: target.environmentId,
                      projectId: project.id,
                    },
                  ])
                }
              >
                Add {project.title}
              </Button>
            ))}
          </div>
          {target.projects.length === 0 ? (
            <p className="text-sm">No authorized projects are available on this worker.</p>
          ) : null}
        </>
      ) : !query.loading && !query.error ? (
        <p className="text-xs text-muted-foreground">
          This Main supports only its configured default worker.
        </p>
      ) : null}
    </section>
  );
}
