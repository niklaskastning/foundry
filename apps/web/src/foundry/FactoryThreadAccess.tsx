import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironments } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { deviceCommand } from "./devices";

export function FactoryThreadAccess({
  environmentId,
  factoryId,
  runId,
  children,
}: {
  environmentId?: EnvironmentId | undefined;
  factoryId?: string | undefined;
  runId?: string | undefined;
  children: ReactNode;
}) {
  const { environments, isReady } = useEnvironments();
  if (
    !environmentId ||
    !factoryId ||
    !runId ||
    environments.some((entry) => entry.environmentId === environmentId)
  )
    return children;
  return (
    <WorkerAccessPanel
      key={environmentId}
      environmentId={environmentId}
      factoryId={factoryId}
      runId={runId}
      ready={isReady}
    />
  );
}

export function FactoryThreadPending({
  environmentId,
  factoryId,
  runId,
  missing,
  error,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  missing: boolean;
  error: string | null;
}) {
  const { environments } = useEnvironments();
  const connection = environments.find(
    (entry) => entry.environmentId === environmentId,
  )?.connection;
  const failure = error ?? connection?.error;
  const unavailable =
    connection?.phase === "offline" ||
    connection?.phase === "error" ||
    connection?.phase === "unsupported";
  return (
    <div
      {...workspaceAreaProps("home", 1, "Factory thread connection")}
      className="mx-auto w-full max-w-2xl space-y-5 p-6 pt-20"
    >
      <Link
        to="/foundry"
        search={{ view: "factories", factoryId, runId, tab: "runs" }}
        className="text-sm underline"
      >
        ← Back to factory run
      </Link>
      <h1 className="text-xl font-semibold">
        {missing
          ? "Thread no longer available"
          : failure || unavailable
            ? "Worker thread unavailable"
            : "Opening worker thread"}
      </h1>
      <p
        role={failure || missing || unavailable ? "alert" : "status"}
        className="text-sm text-muted-foreground"
      >
        {missing
          ? "This thread was removed or archived. The factory run and its saved results remain available."
          : (failure ??
            (unavailable
              ? "The worker is not connected. Check its access and connection in Resources, or return to the run to review saved results."
              : "Waiting for the worker connection and thread history. Your factory context is preserved."))}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          Retry connection
        </Button>
        <Button variant="outline" render={<Link to="/foundry" search={{ view: "resources" }} />}>
          Worker resources
        </Button>
      </div>
    </div>
  );
}

function WorkerAccessPanel({
  environmentId,
  factoryId,
  runId,
  ready,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  ready: boolean;
}) {
  const run = useAtomCommand(deviceCommand, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function connect() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const loaded = await run({ type: "load" });
    if (!AsyncResult.isSuccess(loaded)) {
      const error = squashAtomCommandFailure(loaded);
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not load worker access. Retry the connection.",
      );
      setBusy(false);
      return;
    }
    const device = loaded.value.catalog?.devices.find(
      (entry) => entry.environmentId === environmentId,
    );
    if (
      !device ||
      device.revoked ||
      !device.clientAccess.enabled ||
      !device.online ||
      !device.rpcReady
    ) {
      setMessage(
        !device
          ? "This worker is not registered with the current instance. Return to the run to review its saved results."
          : device.revoked || !device.clientAccess.enabled
            ? "Interactive access to this worker is not authorized. Ask the instance operator to review its access in Resources."
            : "This worker is offline or its interactive connection is unavailable. Return to the run to review its saved results, or retry when it reconnects.",
      );
      setBusy(false);
      return;
    }
    const selected = await run({ type: "select", deviceId: device.deviceId });
    if (AsyncResult.isSuccess(selected)) setMessage("Worker selected. Connecting to this thread…");
    else {
      const error = squashAtomCommandFailure(selected);
      setMessage(
        error instanceof Error
          ? error.message
          : "The worker connection could not be opened. Check your access and retry.",
      );
    }
    setBusy(false);
  }

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Factory thread access")}
      role="main"
      className="h-dvh min-w-0 overflow-y-auto scrollbar-gutter-both"
    >
      <div className="mx-auto w-full max-w-2xl space-y-5 p-6 pt-20">
        <Link
          to="/foundry"
          search={{ view: "factories", factoryId, runId, tab: "runs" }}
          className="text-sm underline"
        >
          ← Back to factory run
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Connect to the run’s worker</h1>
          <p className="text-sm text-muted-foreground">
            This thread belongs to a worker that is not connected in this client. Open its
            authorized connection to continue in the same thread.
          </p>
        </div>
        <Button disabled={!ready || busy} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect to worker"}
        </Button>
        <p role="status" className="text-sm">
          {!ready ? "Checking your connections…" : message}
        </p>
      </div>
    </SidebarInset>
  );
}
