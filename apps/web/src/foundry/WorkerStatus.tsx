import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type FoundryWorkerStatus } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

const statusCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "foundry:worker-status",
  tag: WS_METHODS.foundryWorkerStatus,
});
const messages: Record<FoundryWorkerStatus["providerState"], string> = {
  unbound:
    "Ask the worker operator to bind a Codex provider instance in the worker installation configuration.",
  missing:
    "The bound provider instance no longer exists. The worker operator must check its provider settings.",
  unsupported_provider: "This worker binding supports Codex only.",
  disabled: "The bound provider is disabled in the worker's provider settings.",
  not_installed:
    "Codex is not installed for the worker. Ask the worker operator to install it using the worker's provider settings.",
  login_required:
    "Sign in to Codex through the worker's provider settings under its dedicated account. Foundry sign-in does not sign in to Codex.",
  auth_unknown: "Codex authentication could not be verified. Check the worker's provider settings.",
  version_unknown:
    "This Codex version has no verified compatibility status. Check the worker's provider settings.",
  incompatible:
    "The installed Codex version is not compatible. The worker operator must update it.",
  unavailable: "The provider probe did not report readiness. Check the worker's provider settings.",
  ready: "The bound Codex provider is ready.",
};

export function WorkerStatus({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.foundryWorkerReadiness === true;
  const permitted = useAtomValue(statusCommand.permissionAtom(environmentId));
  const run = useAtomCommand(statusCommand, { reportFailure: false });
  const [status, setStatus] = useState<FoundryWorkerStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const initiallyChecked = useRef<EnvironmentId | null>(null);
  async function refresh() {
    setBusy(true);
    setStatus(undefined);
    setFailed(false);
    const result = await run({ environmentId, input: {} });
    if (AsyncResult.isSuccess(result)) setStatus(result.value);
    else setFailed(true);
    setBusy(false);
  }
  const checkInitially = useEffectEvent(() => void refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Check remote worker readiness once its capability and permission become available, without duplicate StrictMode requests.
  useEffect(() => {
    if (!supported || !permitted || initiallyChecked.current === environmentId) return;
    initiallyChecked.current = environmentId;
    checkInitially();
  }, [supported, permitted, environmentId]);

  return (
    <section
      aria-label="Selected worker readiness"
      className="space-y-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Selected worker</h3>
        <Button
          variant="outline"
          disabled={busy || !supported || !permitted}
          onClick={() => void refresh()}
        >
          Refresh readiness
        </Button>
      </div>
      {!config ? (
        <p role="status" className="text-sm">
          Connecting to selected worker…
        </p>
      ) : !supported ? (
        <p className="text-sm text-muted-foreground">
          This device does not support worker readiness checks.
        </p>
      ) : !permitted ? (
        <p className="text-sm text-muted-foreground">
          You do not have permission to inspect this worker's readiness.
        </p>
      ) : busy ? (
        <p role="status" className="text-sm">
          Checking worker…
        </p>
      ) : failed ? (
        <p role="alert" className="text-sm">
          Worker status could not be verified. Check the device connection and retry.
        </p>
      ) : status ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Provider</p>
              <Badge variant={status.providerReady ? "success" : "warning"}>
                {status.providerReady ? "Ready" : "Needs attention"}
              </Badge>
              <p className="break-words text-sm">
                {status.providerInstanceId ?? "No provider bound"}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Capacity</p>
              <Badge
                variant={
                  status.capacityAvailable === null
                    ? "outline"
                    : status.capacityAvailable
                      ? "success"
                      : "warning"
                }
              >
                {status.capacityAvailable === null
                  ? "Unknown"
                  : status.capacityAvailable
                    ? "Available"
                    : "Occupied"}
              </Badge>
              <p className="text-sm">
                {status.capacity !== undefined && status.free != null
                  ? `${status.free} of ${status.capacity} slots free`
                  : status.activeRuns === null
                    ? "Active run count unavailable"
                    : `${status.activeRuns} active runs`}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Last checked</p>
              <p className="text-sm">{new Date(status.checkedAt).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Snapshot, not a reservation</p>
            </div>
          </div>
          {!status.providerReady ? (
            <p className="text-sm">{messages[status.providerState]}</p>
          ) : null}
          <details className="border-t pt-3 text-sm">
            <summary className="cursor-pointer">Provider and configuration details</summary>
            <div className="space-y-2 pt-3 text-muted-foreground">
              <p>{messages[status.providerState]}</p>
              <p>Version: {status.version ?? "Unknown"}</p>
              <p>
                Parallel execution:{" "}
                {status.parallelExecutionVersion === 1 ? "Supported" : "Not advertised"}
              </p>
              <p>
                Readiness does not grant automation access or reserve capacity. Provider
                installation and sign-in are managed on this worker.
              </p>
            </div>
          </details>
        </>
      ) : (
        <p role="status" className="text-sm">
          Waiting to check worker readiness…
        </p>
      )}
    </section>
  );
}
