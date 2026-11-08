import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FoundrySandboxDetail, ManualStart } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { sandboxCommands } from "../../foundry/sandboxes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

async function readRunSandbox(
  registry: Parameters<typeof runAtomCommand>[0],
  environmentId: EnvironmentId,
  factoryId: string,
  runId: string,
) {
  const listed = await runAtomCommand(
    registry,
    sandboxCommands.query,
    { environmentId, input: { action: "list", workflow: { factoryId, runId } } },
    { reportFailure: false },
  );
  if (
    !AsyncResult.isSuccess(listed) ||
    !("allocations" in listed.value) ||
    listed.value.sandboxSupported === false
  )
    throw new Error("Sandbox status unavailable. Refresh to retry.");
  const allocation = listed.value.allocations.find((entry) => {
    const owner = entry.request.owner;
    return owner.kind === "workflow" && owner.factoryId === factoryId && owner.runId === runId;
  });
  if (!allocation) return undefined;
  const result = await runAtomCommand(
    registry,
    sandboxCommands.query,
    { environmentId, input: { action: "get", allocationId: allocation.allocationId } },
    { reportFailure: false },
  );
  if (!AsyncResult.isSuccess(result) || !("allocation" in result.value))
    throw new Error("Sandbox status unavailable. Refresh to retry.");
  const owner = result.value.allocation.request.owner;
  if (
    result.value.allocation.allocationId !== allocation.allocationId ||
    owner.kind !== "workflow" ||
    owner.factoryId !== factoryId ||
    owner.runId !== runId
  )
    throw new Error("Sandbox status unavailable. Refresh to retry.");
  return result.value;
}

export function SandboxRunStatus({
  environmentId,
  factoryId,
  runId,
  target,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  target: NonNullable<ManualStart["sandbox"]>;
}) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(sandboxCommands.query.permissionAtom(environmentId));
  const key = JSON.stringify([environmentId, factoryId, runId]);
  const [generation, setGeneration] = useState(0);
  const [response, setResponse] = useState<{
    key: string;
    detail?: typeof FoundrySandboxDetail.Type;
    error?: string;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe this run's durable allocation, setup output and archive cleanup through Main.
  useEffect(() => {
    if (!canRead) return;
    const requestKey = `${key}:${generation}`;
    let disposed = false;
    let inFlight = false;
    function load() {
      if (inFlight) return;
      inFlight = true;
      void readRunSandbox(registry, environmentId, factoryId, runId).then(
        (detail) => {
          inFlight = false;
          if (!disposed) setResponse(detail ? { key: requestKey, detail } : { key: requestKey });
        },
        () => {
          inFlight = false;
          if (!disposed)
            setResponse({
              key: requestKey,
              error: "Sandbox status unavailable. Refresh to retry.",
            });
        },
      );
    }
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [registry, canRead, environmentId, factoryId, runId, key, generation]);
  if (!canRead) return null;
  const current = response?.key === `${key}:${generation}` ? response : undefined;
  const detail = current?.detail;
  const allocation = detail?.allocation;
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Run sandbox">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Linux sandbox</h3>
        <Badge variant={allocation?.failure ? "error" : "secondary"}>
          {allocation?.state ?? (current?.error ? "unavailable" : "pending allocation / capacity")}
        </Badge>
        <Button variant="outline" size="sm" onClick={() => setGeneration((value) => value + 1)}>
          Refresh sandbox
        </Button>
      </div>
      <p className="break-all text-sm text-muted-foreground">
        Pinned profile: {target.profileId} · {target.revision}
      </p>
      {current?.error ? <p role="alert">{current.error}</p> : null}
      {allocation?.failure ? <p role="alert">Sandbox failure: {allocation.failure}</p> : null}
      {allocation ? (
        <p className="break-all text-sm">Allocation: {allocation.allocationId}</p>
      ) : null}
      {detail?.archiveReceipt ? (
        <p>Central archive confirmed. Cleanup: {allocation?.state}.</p>
      ) : null}
      {detail?.setupLog ? (
        <details>
          <summary>Sandbox setup log</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {detail.setupLog}
          </pre>
        </details>
      ) : null}
      <Link className="text-sm underline" to="/foundry" search={{ view: "resources" }}>
        Open sandbox resources and archives
      </Link>
    </section>
  );
}
