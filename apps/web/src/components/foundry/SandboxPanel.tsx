import { SandboxProviderConnection } from "./SandboxProviderConnection";
import { randomUUID } from "../../lib/utils";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FoundrySandboxDetail,
  FoundrySandboxListResult,
  FoundrySandboxMutation,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { sandboxCommands } from "../../foundry/sandboxes";
import { deviceCommand } from "../../foundry/devices";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/select";
import { SandboxAllocationDetail } from "./SandboxAllocationDetail";

export function SandboxPanel({ environmentId }: { environmentId: EnvironmentId }) {
  return <SandboxPanelContent key={environmentId} environmentId={environmentId} />;
}
function SandboxPanelContent({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(sandboxCommands.query.permissionAtom(environmentId));
  const canOperate = useAtomValue(sandboxCommands.command.permissionAtom(environmentId));
  const [catalog, setCatalog] = useState<typeof FoundrySandboxListResult.Type>();
  const [detail, setDetail] = useState<typeof FoundrySandboxDetail.Type>();
  const [selectedId, setSelectedId] = useState<string>();
  const [profileKey, setProfileKey] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingRequest = useRef<{ key: string; commandId: string } | null>(null);
  const command = useAtomCommand(sandboxCommands.command, { reportFailure: false });
  const device = useAtomCommand(deviceCommand, { reportFailure: false });
  const navigate = useNavigate();
  const profiles =
    (canRead ? catalog : undefined)?.profiles.filter((profile) => profile.enabled) ?? [];
  const selectedProfile =
    profiles.find((profile) => `${profile.profileId}:${profile.revision}` === profileKey) ??
    profiles[0];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe authenticated allocation state and setup output while the resource panel is mounted.
  useEffect(() => {
    if (!canRead) return;
    const refreshGeneration = generation;
    let disposed = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      const result = await runAtomCommand(
        registry,
        sandboxCommands.query,
        { environmentId, input: { action: "list" } },
        { reportFailure: false },
      );
      if (!disposed && refreshGeneration === generation) {
        if (AsyncResult.isSuccess(result) && "profiles" in result.value) setCatalog(result.value);
        else {
          setCatalog(undefined);
          setMessage("Unable to load sandboxes. Check the Main connection and permissions.");
        }
      }
      if (selectedId && !disposed) {
        const result = await runAtomCommand(
          registry,
          sandboxCommands.query,
          { environmentId, input: { action: "get", allocationId: selectedId } },
          { reportFailure: false },
        );
        if (!disposed)
          setDetail(
            AsyncResult.isSuccess(result) && "allocation" in result.value
              ? result.value
              : undefined,
          );
      }
      inFlight = false;
    };
    void load();
    const timer = window.setInterval(load, 5000);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [registry, environmentId, canRead, selectedId, generation]);
  async function mutate(input: typeof FoundrySandboxMutation.Type) {
    setBusy(true);
    const result = await command({ environmentId, input });
    if (AsyncResult.isSuccess(result)) {
      setSelectedId(result.value.allocationId);
      setMessage("Request accepted.");
      if (input.action === "request") pendingRequest.current = null;
      setGeneration((value) => value + 1);
    } else {
      const failure = squashAtomCommandFailure(result);
      setMessage(failure instanceof Error ? failure.message : "Sandbox operation failed.");
    }
    setBusy(false);
  }
  function request(resumeThreadId?: ThreadId) {
    const source =
      resumeThreadId && detail && detail.allocation.allocationId === selectedId
        ? detail.allocation
        : null;
    const profile = selectedProfile;
    if (!profile) return;
    const key = `${profile.profileId}:${profile.revision}:${source?.allocationId ?? ""}:${resumeThreadId ?? ""}`;
    if (pendingRequest.current?.key !== key)
      pendingRequest.current = { key, commandId: randomUUID() };
    void mutate({
      action: "request",
      request: {
        commandId: pendingRequest.current.commandId,
        profileId: profile.profileId,
        revision: profile.revision,
        owner: { kind: "interactive" },
        ...(source && resumeThreadId
          ? { resumeAllocationId: source.allocationId, resumeThreadId }
          : {}),
      },
    });
  }
  async function openEnvironment() {
    if (!detail?.allocation.deviceId) return;
    setBusy(true);
    const result = await device({ type: "select", deviceId: detail.allocation.deviceId });
    if (AsyncResult.isSuccess(result)) await navigate({ to: "/chats" });
    else setMessage("Unable to open this environment. Refresh its device connection.");
    setBusy(false);
  }
  return (
    <section className="space-y-4" aria-label="Linux sandboxes">
      <SandboxProviderConnection
        environmentId={environmentId}
        {...(selectedProfile ? { connectionId: selectedProfile.providerConnectionId } : {})}
      />
      <p className="text-sm text-muted-foreground">
        Start a fresh Linux environment from a pinned profile. Interactive work and workflows use
        the same profiles.
      </p>
      {!canRead ? (
        <p role="alert">A current Main session with read permission is required.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={
            selectedProfile ? `${selectedProfile.profileId}:${selectedProfile.revision}` : null
          }
          onValueChange={(value) => {
            if (value !== null) setProfileKey(value);
          }}
        >
          <SelectTrigger aria-label="Sandbox profile revision">
            <SelectValue>
              {selectedProfile
                ? `${selectedProfile.label} · ${selectedProfile.revision.slice(0, 8)}`
                : "No enabled profiles"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map((profile) => (
              <SelectItem key={profile.revision} value={`${profile.profileId}:${profile.revision}`}>
                {profile.label} · {profile.revision.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button disabled={busy || !canOperate || !selectedProfile} onClick={() => request()}>
          Create sandbox
        </Button>
        <Button
          variant="outline"
          disabled={!canRead}
          onClick={() => setGeneration((value) => value + 1)}
        >
          Refresh
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {catalog?.allocations.length === 0 ? (
        <p className="text-sm">No sandbox allocations yet.</p>
      ) : null}
      <div className="space-y-2">
        {(canRead ? catalog : undefined)?.allocations.map((allocation) => (
          <div key={allocation.allocationId} className="flex flex-wrap items-center gap-2">
            <Button
              variant={selectedId === allocation.allocationId ? "secondary" : "outline"}
              onClick={() => setSelectedId(allocation.allocationId)}
            >
              {allocation.profile.label} · {allocation.allocationId.slice(0, 8)}
            </Button>
            <Badge
              variant={
                allocation.state === "ready"
                  ? "success"
                  : allocation.state === "failed"
                    ? "error"
                    : "secondary"
              }
            >
              {allocation.state}
            </Badge>
            <span className="text-xs text-muted-foreground">{allocation.request.owner.kind}</span>
          </div>
        ))}
      </div>
      {canRead && detail && detail.allocation.allocationId === selectedId ? (
        <SandboxAllocationDetail
          key={selectedId}
          detail={detail}
          busy={busy}
          canOperate={canOperate}
          resumeProfile={
            selectedProfile
              ? `${selectedProfile.label} · ${selectedProfile.revision.slice(0, 8)}`
              : undefined
          }
          onCommand={(input) => void mutate(input)}
          onResume={request}
          onOpen={() => void openEnvironment()}
        />
      ) : null}
    </section>
  );
}
