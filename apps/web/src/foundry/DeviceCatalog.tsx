import { WorkerStatus } from "./WorkerStatus";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { FoundryDeviceCatalog, FoundryEnrollment } from "@t3tools/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { deviceCommand } from "./devices";
import { readDeviceSelection } from "./selection";

export function DeviceCatalog() {
  const [catalog, setCatalog] = useState<FoundryDeviceCatalog>();
  const [enrollment, setEnrollment] = useState<FoundryEnrollment>();
  const [environmentId, setEnvironmentId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState(
    "Load the device list after signing in to Foundry and pairing this client with Main.",
  );
  const [busy, setBusy] = useState(false);
  const run = useAtomCommand(deviceCommand, { reportFailure: false });
  const navigate = useNavigate();
  const selected = readDeviceSelection()?.[0]?.target;

  async function operate(input: Parameters<typeof run>[0]) {
    setBusy(true);
    const result = await run(input);
    if (AsyncResult.isSuccess(result)) {
      if (result.value.catalog) setCatalog(result.value.catalog);
      setEnrollment(result.value.enrollment);
      setMessage(
        input.type === "disconnect"
          ? "Foundry device disconnected. Personal T3 connections are unchanged."
          : "Device list updated. Visibility alone does not grant execution permission.",
      );
      if (input.type === "select") await navigate({ to: "/" });
    } else {
      const error = squashAtomCommandFailure(result);
      setMessage(error instanceof Error ? error.message : "Device operation failed.");
      setCatalog(undefined);
      setEnrollment(undefined);
    }
    setBusy(false);
    return AsyncResult.isSuccess(result);
  }

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
        Devices belong to this Foundry instance. A Foundry login and a Main T3 session are separate
        requirements; no pairing with each device is needed. Projects and threads open in the
        existing workspace views.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void operate({ type: "disconnect" }).then((success) => {
              if (success) window.location.assign("/foundry");
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
      <p role="status" className="text-sm">
        {busy ? "Updating devices…" : message}
      </p>
      {selected ? (
        <WorkerStatus key={selected.environmentId} environmentId={selected.environmentId} />
      ) : null}
      {catalog?.devices.length === 0 ? <p className="text-sm">No devices registered.</p> : null}
      {catalog?.devices.map((device) => (
        <div key={device.deviceId} className="space-y-2 rounded-md border p-3">
          <p className="break-all text-sm font-medium">
            {device.environmentId}
            {selected?.environmentId === device.environmentId ? " · selected" : ""}
          </p>
          <p className="break-all text-xs text-muted-foreground">Device ID: {device.deviceId}</p>
          <p className="text-sm">
            {device.revoked
              ? "Registration revoked"
              : device.online
                ? device.rpcReady
                  ? "Online"
                  : "Online · interactive transport unavailable"
                : "Offline"}{" "}
            · {device.clientAccess.enabled ? "Client access enabled" : "Client access disabled"}
          </p>
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
            {catalog.canManage && !device.revoked ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void operate({
                      type: "access",
                      deviceId: device.deviceId,
                      enabled: !device.clientAccess.enabled,
                      generation: device.clientAccess.generation,
                    })
                  }
                >
                  {device.clientAccess.enabled ? "Disable client access" : "Enable client access"}
                </Button>
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
              </>
            ) : null}
          </div>
        </div>
      ))}
      {catalog?.canManage ? (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Register a machine</p>
          <p className="text-xs text-muted-foreground">
            Prepare a device request on the machine with the Foundry CLI. Enter its environment ID
            and public key, then transfer the downloaded approval securely to that machine. Approval
            expires after ten minutes. Private keys stay on the machine.
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
      ) : null}
    </div>
  );
}
