import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type FoundryWorkerStatus } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
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
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .foundryWorkerReadiness === true;
  const permitted = useAtomValue(statusCommand.permissionAtom(environmentId));
  const run = useAtomCommand(statusCommand, { reportFailure: false });
  const [status, setStatus] = useState<FoundryWorkerStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function refresh() {
    setBusy(true);
    setStatus(undefined);
    setFailed(false);
    const result = await run({ environmentId, input: {} });
    if (AsyncResult.isSuccess(result)) setStatus(result.value);
    else setFailed(true);
    setBusy(false);
  }
  if (!supported) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Button variant="outline" disabled={busy || !permitted} onClick={() => void refresh()}>
        Check selected worker
      </Button>
      <div role="status" className="text-sm">
        {busy ? (
          "Checking worker…"
        ) : failed ? (
          "Worker status could not be verified. Check the device connection and retry."
        ) : status ? (
          <>
            <p>Snapshot: {status.checkedAt} · worker responded online</p>
            <p>
              Provider ready: {status.providerReady ? "yes" : "no"} ·{" "}
              {status.providerInstanceId ?? "no binding"} · {status.version ?? "version unknown"}
            </p>
            <p>{messages[status.providerState]}</p>
            <p>
              Capacity available:{" "}
              {status.capacityAvailable === null
                ? "unknown"
                : status.capacityAvailable
                  ? "yes"
                  : "no"}{" "}
              · active runs: {status.activeRuns ?? "unknown"}
            </p>
          </>
        ) : (
          "Check the selected worker's provider and run capacity."
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Capacity is a snapshot of unfinished runs, not a reservation. This check does not start an
        agent or grant automation access. Provider installation and sign-in require the worker
        operator's local access; personal credentials must not be copied.
      </p>
    </div>
  );
}
