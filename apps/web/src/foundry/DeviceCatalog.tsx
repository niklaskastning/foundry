import { WorkerStatus } from "./WorkerStatus";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { FoundryDeviceCatalog, FoundryEnrollment } from "@t3tools/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { deviceCommand } from "./devices";
import { readDeviceSelection } from "./selection";

export function DeviceCatalog() {
  const [catalog, setCatalog] = useState<FoundryDeviceCatalog>();
  const [enrollment, setEnrollment] = useState<FoundryEnrollment>();
  const [environmentId, setEnvironmentId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const initialLoadStarted = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useAtomCommand(deviceCommand, { reportFailure: false });
  const navigate = useNavigate();
  const selected = readDeviceSelection()?.[0]?.target;

  async function operate(input: Parameters<typeof run>[0]) {
    setBusy(true);
    setFailed(false);
    const result = await run(input);
    if (AsyncResult.isSuccess(result)) {
      if (result.value.catalog) setCatalog(result.value.catalog);
      setEnrollment(result.value.enrollment);
      setMessage(
        input.type === "disconnect"
          ? "Foundry device disconnected. Personal T3 connections are unchanged."
          : "Device list updated.",
      );
      if (input.type === "select") await navigate({ to: "/chats" });
    } else {
      setFailed(true);
      const error = squashAtomCommandFailure(result);
      setMessage(error instanceof Error ? error.message : "Device operation failed.");
      setCatalog(undefined);
      setEnrollment(undefined);
    }
    setBusy(false);
    return AsyncResult.isSuccess(result);
  }

  const loadInitially = useEffectEvent(() => void operate({ type: "load" }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the remote device catalog once when this resource view mounts, including StrictMode effect replay.
  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    loadInitially();
  }, []);

  function downloadEnrollment() {
    if (!enrollment) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(enrollment)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "foundry-enrollment.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setEnrollment(undefined);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Machines available to this instance. Open a device to work in its projects and chats, or
        manage which machines may execute factory work.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void operate({ type: "disconnect" }).then((success) => {
              if (success) window.location.assign("/foundry?view=instance");
            });
          }}
        >
          Manage instance sign-in
        </Button>
        <Button disabled={busy} onClick={() => void operate({ type: "load" })}>
          Refresh devices
        </Button>
        <Button
          variant="outline"
          disabled={busy || !selected}
          onClick={() => void operate({ type: "disconnect" })}
        >
          Disconnect selected device
        </Button>
      </div>
      <p role={failed ? "alert" : "status"} className="text-sm text-muted-foreground">
        {busy ? "Loading devices…" : message}
      </p>
      {selected ? (
        <WorkerStatus key={selected.environmentId} environmentId={selected.environmentId} />
      ) : null}
      {catalog?.devices.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm">
          <p className="font-medium">No machines registered</p>
          <p className="mt-1 text-muted-foreground">
            Register a worker below to make its projects available to this instance.
          </p>
        </div>
      ) : null}
      {catalog && !catalog.canManage ? (
        <p className="text-sm text-muted-foreground">
          You can open authorized devices. Managing registration and access requires additional
          permission.
        </p>
      ) : null}
      {catalog?.devices.map((device) => (
        <div key={device.deviceId} className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {selected?.environmentId === device.environmentId ? "Selected device" : "Device"}
              </p>
              <h3 className="mt-1 break-all text-sm font-medium">{device.environmentId}</h3>
            </div>
            <Badge
              variant={
                device.revoked
                  ? "error"
                  : device.online && device.rpcReady
                    ? "success"
                    : "secondary"
              }
            >
              {device.revoked
                ? "Revoked"
                : device.online
                  ? device.rpcReady
                    ? "Online"
                    : "Transport unavailable"
                  : "Offline"}
            </Badge>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Interactive access</dt>
              <dd className="mt-1">{device.clientAccess.enabled ? "Allowed" : "Disabled"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Factory execution</dt>
              <dd className="mt-1">
                {device.automationExecution
                  ? device.automationExecution.enabled
                    ? "Authorized"
                    : "Not authorized"
                  : "Not supported"}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                device.revoked ||
                !device.online ||
                !device.rpcReady ||
                !device.clientAccess.enabled
              }
              onClick={() => void operate({ type: "select", deviceId: device.deviceId })}
            >
              Open device
            </Button>
          </div>
          <details className="border-t pt-3 text-sm">
            <summary className="cursor-pointer">Access and registration</summary>
            <div className="space-y-3 pt-3">
              <p className="break-all text-xs text-muted-foreground">
                Device ID: {device.deviceId}
              </p>
              <p className="text-xs text-muted-foreground">
                Interactive access and factory execution are separate permissions. Allowing
                execution does not start work.
              </p>
              {catalog.canManage && !device.revoked ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void operate({
                        type: "access",
                        kind: "clientAccess",
                        deviceId: device.deviceId,
                        enabled: !device.clientAccess.enabled,
                        generation: device.clientAccess.generation,
                      })
                    }
                  >
                    {device.clientAccess.enabled ? "Disable client access" : "Enable client access"}
                  </Button>
                  {device.automationExecution ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void operate({
                          type: "access",
                          kind: "automationExecution",
                          deviceId: device.deviceId,
                          enabled: !device.automationExecution!.enabled,
                          generation: device.automationExecution!.generation,
                        })
                      }
                    >
                      {device.automationExecution.enabled
                        ? "Revoke automation execution"
                        : "Allow automation execution"}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Revoke this device registration for all clients? Connecting it again requires a new registration.",
                        )
                      )
                        void operate({ type: "revoke", deviceId: device.deviceId });
                    }}
                  >
                    Revoke registration…
                  </Button>
                </div>
              ) : null}
            </div>
          </details>
        </div>
      ))}
      {catalog?.canManage ? (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">Register a machine</summary>
          <div className="space-y-3 pt-4">
            <p className="text-xs text-muted-foreground">
              Prepare a device request on the machine with the Foundry CLI. Enter its environment ID
              and public key, then transfer the downloaded approval securely to that machine.
              Approval expires after ten minutes. Private keys stay on the machine.
            </p>
            <label className="text-sm" htmlFor="foundry-device-environment">
              Environment ID
            </label>
            <Input
              id="foundry-device-environment"
              value={environmentId}
              onChange={(event) => setEnvironmentId(event.target.value)}
              disabled={busy}
            />
            <label className="text-sm" htmlFor="foundry-device-key">
              Device public key
            </label>
            <Input
              id="foundry-device-key"
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              disabled={busy}
            />
            <Button
              disabled={busy || !environmentId || !publicKey}
              onClick={() => void operate({ type: "approve", environmentId, publicKey })}
            >
              Approve registration
            </Button>
            {enrollment ? (
              <Button variant="outline" onClick={downloadEnrollment}>
                Download private enrollment approval
              </Button>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
