import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AutomationApplicationResult,
  EnvironmentId,
  FoundryDeviceId,
} from "@t3tools/contracts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";

type WorkerBinding = Extract<AutomationApplicationResult, { kind: "workerBinding" }>;

export function WorkerCapacity({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useAutomationQuery(environmentId, { op: "workerBinding" });
  const binding = query.result?.kind === "workerBinding" ? query.result : null;
  const [selected, setSelected] = useState<FoundryDeviceId | null>(null);
  const workers = binding?.workers ?? (binding ? [binding] : []);
  const selectedWorker = workers.find((worker) => worker.deviceId === selected) ?? binding;
  return (
    <section aria-label="Factory workers" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Factory workers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Configured execution targets. Pausing stops new dispatch; running work continues.
          </p>
        </div>
        <Button variant="outline" disabled={query.loading} onClick={query.refresh}>
          Refresh workers
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm">
          {query.error}
        </p>
      ) : null}
      {query.loading && !binding ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading configured workers…
        </p>
      ) : null}
      {workers.length > 1 ? (
        <div aria-label="Choose factory worker" className="flex flex-wrap gap-2">
          {workers.map((worker, index) => (
            <Button
              key={worker.deviceId}
              variant={worker.deviceId === selectedWorker?.deviceId ? "default" : "outline"}
              aria-pressed={worker.deviceId === selectedWorker?.deviceId}
              onClick={() => setSelected(worker.deviceId)}
            >
              Worker {index + 1} · {worker.environmentId.slice(0, 8)}
            </Button>
          ))}
        </div>
      ) : null}
      {binding && selectedWorker ? (
        selectedWorker.deviceId === binding.deviceId ? (
          <WorkerDetails
            key={binding.deviceId}
            environmentId={environmentId}
            binding={binding}
            loading={query.loading}
            onRefresh={query.refresh}
          />
        ) : (
          <SelectedWorker
            key={selectedWorker.deviceId}
            environmentId={environmentId}
            deviceId={selectedWorker.deviceId}
          />
        )
      ) : null}
    </section>
  );
}

function SelectedWorker({
  environmentId,
  deviceId,
}: {
  environmentId: EnvironmentId;
  deviceId: FoundryDeviceId;
}) {
  const query = useAutomationQuery(environmentId, { op: "workerBinding", deviceId });
  const binding = query.result?.kind === "workerBinding" ? query.result : null;
  return (
    <div className="space-y-3">
      {query.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {query.error}
          </p>
          <Button variant="outline" onClick={query.refresh}>
            Retry worker connection
          </Button>
        </div>
      ) : null}
      {query.loading && !binding ? (
        <p role="status" className="text-sm">
          Checking selected worker…
        </p>
      ) : null}
      {binding ? (
        <WorkerDetails
          environmentId={environmentId}
          binding={binding}
          loading={query.loading}
          onRefresh={query.refresh}
        />
      ) : null}
    </div>
  );
}

function WorkerDetails({
  environmentId,
  binding,
  loading,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  binding: WorkerBinding;
  loading: boolean;
  onRefresh: () => void;
}) {
  const run = useAtomCommand(automationCommands.command, { reportFailure: false });
  const permitted = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "setWorkerPaused" }),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const status = binding.status;
  const canPause = typeof binding.paused === "boolean";
  async function setPaused(paused: boolean) {
    if (busy || loading || !permitted || !canPause) return;
    setBusy(true);
    setMessage("");
    const result = await run({
      environmentId,
      input: { op: "setWorkerPaused", deviceId: binding.deviceId, paused },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result) && result.value.kind === "workerCapacity") {
      setFailed(false);
      setMessage(
        result.value.paused
          ? "New dispatch paused. Running work continues."
          : "Worker resumed for new dispatch.",
      );
    } else {
      setFailed(true);
      const error = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
      setMessage(
        error instanceof Error
          ? error.message
          : "Worker change was not confirmed. Refresh its current state before trying again.",
      );
    }
    onRefresh();
  }
  return (
    <article className="space-y-3 border-y py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">Execution worker</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {binding.projects.length} available projects · checked{" "}
            {new Date(status.checkedAt).toLocaleString()}
          </p>
        </div>
        <Badge variant={binding.paused ? "warning" : "outline"}>
          {binding.paused === undefined
            ? "Dispatch state unavailable"
            : binding.paused
              ? "Dispatch paused"
              : "Dispatch enabled"}
        </Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Provider</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant={status.providerReady ? "success" : "warning"}>
              {status.providerReady ? "Ready" : "Needs attention"}
            </Badge>
            <span className="break-words">{status.providerInstanceId ?? "No provider bound"}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Execution capacity</dt>
          <dd className="mt-1 font-medium">
            {status.capacity !== undefined && status.free != null
              ? `${status.free} of ${status.capacity} slots free`
              : status.capacityAvailable === null
                ? "Unknown"
                : status.capacityAvailable
                  ? "Available"
                  : "Occupied"}
          </dd>
          <dd className="mt-1 text-xs text-muted-foreground">
            {status.occupied != null ? `${status.occupied} occupied` : "Occupied slots unavailable"}
            {binding.reserved !== undefined ? ` · ${binding.reserved} reserved by Main` : ""}
          </dd>
        </div>
      </dl>
      {!status.providerReady ? (
        <p role="status" className="text-sm">
          Provider status: {status.providerState.replaceAll("_", " ")}. Check the worker's provider
          settings.
        </p>
      ) : null}
      {canPause ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy || loading || !permitted}
            onClick={() => void setPaused(!binding.paused)}
          >
            {busy ? "Saving…" : binding.paused ? "Resume dispatch" : "Pause new dispatch"}
          </Button>
          {!permitted ? (
            <p className="text-sm text-muted-foreground">
              Managing dispatch requires worker access permission.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This Main does not expose dispatch controls for this worker.
        </p>
      )}
      {message ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {message}
        </p>
      ) : null}
      <details className="border-t pt-3 text-sm">
        <summary className="cursor-pointer">Projects and worker details</summary>
        <div className="space-y-3 pt-3">
          <p className="break-all text-muted-foreground">
            Environment: {binding.environmentId} · Device: {binding.deviceId} · Provider version:{" "}
            {status.version ?? "Unknown"}
          </p>
          <p className="text-muted-foreground">
            Parallel execution:{" "}
            {status.parallelExecutionVersion === 1 ? "Supported" : "Not advertised"}.
          </p>
          <p className="text-muted-foreground">
            Capacity is a snapshot, not a reservation. Client access and factory execution
            authorization are managed separately below.
          </p>
          {binding.projects.length ? (
            <ul className="space-y-2">
              {binding.projects.map((project) => (
                <li key={project.id}>
                  <p className="font-medium">{project.title}</p>
                  <p className="break-all text-xs text-muted-foreground">{project.workspaceRoot}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>No projects are available on this worker.</p>
          )}
        </div>
      </details>
    </article>
  );
}
