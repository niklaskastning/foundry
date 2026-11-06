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
  const id = connectionId ?? draftId;
  const loaded = catalog?.revision === revision;
  const existing = (loaded ? catalog.connections : []).find((entry) => entry.id === id);
  const selected = providers.find(
    (provider) => provider.instanceId === providerId && provider.driver === "codex",
  );
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
      {connectionId ? (
        <p>Profile connection: {connectionId}</p>
      ) : (
        <Input
          aria-label="Sandbox connection ID"
          value={draftId}
          onChange={(event) => setDraftId(event.target.value)}
          disabled={!canWrite}
        />
      )}
      <Select
        value={providerId ?? ""}
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
      {selected ? (
        <ProviderAuthenticationSection
          key={selected.instanceId}
          environmentId={environmentId}
          environmentLabel="Main"
          instanceId={selected.instanceId}
          provider={selected}
          readOnly={!canWrite}
        />
      ) : null}
      {existing ? (
        <p>
          {existing.revoked ? "Revoked" : "Authorized"} · {existing.label} · revision{" "}
          {existing.generation}
        </p>
      ) : null}
      {existing && !existing.revoked ? (
        <p className="text-sm text-muted-foreground">
          Replacing this connection stops and archives its existing sandboxes.
        </p>
      ) : null}
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
          disabled={!canRead}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh connections
        </Button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
