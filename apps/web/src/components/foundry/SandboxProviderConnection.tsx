import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FoundryProviderConnectionSummary,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { providerConnectionCommands } from "../../foundry/providerConnections";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderAuthenticationSection } from "../settings/ProviderAuthenticationSection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/select";

export function SandboxProviderConnection({
  environmentId,
  connectionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly connectionId?: string;
}) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(providerConnectionCommands.query.permissionAtom(environmentId));
  const canWrite = useAtomValue(providerConnectionCommands.command.permissionAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers = (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? []
  ).filter((provider) => {
    const config = settings?.providerInstances[provider.instanceId]?.config;
    return (
      provider.driver === "codex" &&
      typeof config === "object" &&
      config !== null &&
      "setupMode" in config &&
      config.setupMode === "managed"
    );
  });
  const [providerId, setProviderId] = useState<ProviderInstanceId>();
  const [draftId, setDraftId] = useState("sandbox-codex");
  const [catalog, setCatalog] = useState<{
    revision: number;
    connections: ReadonlyArray<FoundryProviderConnectionSummary>;
  }>();
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useAtomCommand(providerConnectionCommands.command, { reportFailure: false });
  const refreshProvider = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const id = connectionId ?? draftId;
  const loaded = canRead && catalog?.revision === revision;
  const existing = (loaded ? catalog.connections : []).find((entry) => entry.id === id);
  const selected = providers.find(
    (provider) => provider.instanceId === (providerId ?? existing?.providerInstanceId),
  );

  async function checkMain() {
    if (!selected || busy) return;
    setBusy(true);
    const result = await refreshProvider({
      environmentId,
      input: { instanceId: selected.instanceId, reloadSecrets: true },
    });
    setBusy(false);
    setMessage(
      AsyncResult.isSuccess(result)
        ? "Main provider status updated. This does not probe a worker or change its authorization."
        : "Unable to check the Main provider. Check your connection and retry.",
    );
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the authorized Main connection catalog when mounted or changed by an explicit operation.
  useEffect(() => {
    if (!canRead) return;
    let disposed = false;
    void runAtomCommand(
      registry,
      providerConnectionCommands.query,
      { environmentId, input: { op: "list" } },
      { reportFailure: false },
    ).then((result) => {
      if (disposed) return;
      if (AsyncResult.isSuccess(result))
        setCatalog({ revision, connections: result.value.connections });
      else setMessage("Unable to read central connections. Check your Main session.");
    });
    return () => {
      disposed = true;
    };
  }, [registry, environmentId, canRead, revision]);

  async function connect() {
    if (!selected || busy) return;
    setBusy(true);
    const result = await command({
      environmentId,
      input: {
        op: "connect",
        input: {
          id,
          label: `Sandbox · ${selected.displayName ?? selected.instanceId}`,
          providerInstanceId: selected.instanceId,
          expectedGeneration: existing?.generation ?? null,
        },
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setMessage("Central connection authorized for sandbox profiles.");
      setRevision((value) => value + 1);
    } else {
      const failure = squashAtomCommandFailure(result);
      setMessage(
        failure instanceof Error
          ? failure.message
          : "Sign in with managed Codex on Main before connecting.",
      );
    }
  }
  async function revoke() {
    if (busy) return;
    setBusy(true);
    const result = await command({ environmentId, input: { op: "revoke", id } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setMessage(
        "Sandbox access revoked. Bound environments will stop and archive their work. Already issued access tokens retain their upstream expiry.",
      );
      setRevision((value) => value + 1);
    } else setMessage("Unable to revoke this connection. Refresh and retry.");
  }
  return (
    <section aria-label="Central Codex connection" className="space-y-3">
      <h3 className="text-sm font-medium">Central Codex connection</h3>
      <p className="text-sm text-muted-foreground">
        Choose a managed Codex instance on Main, sign in with ChatGPT, then explicitly authorize it
        for sandboxes. Add a dedicated managed instance in Settings → Providers if needed.
      </p>
      {!connectionId && loaded && catalog.connections.length > 0 ? (
        <Select
          value={existing?.id ?? ""}
          disabled={busy || !canRead}
          onValueChange={(value) => {
            if (!value) return;
            setDraftId(value);
            setProviderId(undefined);
            setMessage("");
          }}
        >
          <SelectTrigger aria-label="Saved central connection">
            <SelectValue placeholder="Choose a saved connection" />
          </SelectTrigger>
          <SelectContent>
            {catalog.connections.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label} · {entry.id}
                {entry.revoked ? " · Revoked" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {connectionId ? (
        <p>Profile connection: {connectionId}</p>
      ) : (
        <Input
          aria-label="Sandbox connection ID"
          value={draftId}
          onChange={(event) => {
            setDraftId(event.target.value);
            setProviderId(undefined);
            setMessage("");
          }}
          disabled={!canWrite || busy}
        />
      )}
      <Select
        value={selected?.instanceId ?? ""}
        disabled={!canWrite || busy}
        onValueChange={(value) =>
          setProviderId(providers.find((provider) => provider.instanceId === value)?.instanceId)
        }
      >
        <SelectTrigger aria-label="Central Codex instance">
          <SelectValue placeholder="Choose a Codex instance" />
        </SelectTrigger>
        <SelectContent>
          {providers
            .filter((provider) => provider.driver === "codex")
            .map((provider) => (
              <SelectItem key={provider.instanceId} value={provider.instanceId}>
                {provider.displayName ?? provider.instanceId}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {providers.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No managed Codex instance is available on Main. Configure one in Settings → Providers for
          the Main environment. CLI accounts and other providers cannot authorize this connection.
        </p>
      ) : null}
      {selected ? (
        <div className="space-y-3">
          <p className="text-sm">
            Main account: {selected.auth.status} · CLI:{" "}
            {selected.installed ? "installed" : "not installed"}. This is Main’s status, not worker
            execution readiness.
          </p>
          <ProviderAuthenticationSection
            key={selected.instanceId}
            environmentId={environmentId}
            environmentLabel="Main"
            instanceId={selected.instanceId}
            provider={selected}
            readOnly={!canWrite || busy}
          />
          <Button variant="outline" disabled={!canRead || busy} onClick={() => void checkMain()}>
            Check Main provider
          </Button>
        </div>
      ) : null}
      {existing ? (
        <p>
          {existing.revoked ? "Sandbox access revoked" : "Sandbox access authorized"} ·{" "}
          {existing.label} · revision {existing.generation}
        </p>
      ) : null}
      {existing && !existing.revoked ? (
        <p className="text-sm text-muted-foreground">
          Replacing this connection stops and archives its existing sandboxes.
        </p>
      ) : null}
      {existing && !selected ? (
        <p role="status" className="text-sm text-muted-foreground">
          This connection’s managed Codex instance is unavailable on Main. Select an available
          instance to replace it, or revoke access.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Tokens renew on Main when an authorized sandbox requests access. To renew sign-in, use
        Change account or Sign in above, then authorize the connection again. Reauthorization
        replaces its revision and stops existing bound sandboxes.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canWrite || !loaded || !selected || !id || busy}
          onClick={() => void connect()}
        >
          Authorize selected connection
        </Button>
        {existing && !existing.revoked ? (
          <Button variant="outline" disabled={!canWrite || busy} onClick={() => void revoke()}>
            Revoke sandbox access
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={!canRead || busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh connections
        </Button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
