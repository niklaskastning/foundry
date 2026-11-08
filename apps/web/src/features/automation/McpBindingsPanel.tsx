import { FoundryUI } from "../../foundry/FoundryUI";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  SetFactoryMcpBinding,
  type EnvironmentId,
  type FactoryMcpBinding,
  type FactoryV4Mcp,
} from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";

const decodeBinding = Schema.decodeSync(SetFactoryMcpBinding);

export function McpBindingsPanel({
  environmentId,
  factoryId,
  resources,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  resources: readonly FactoryV4Mcp[];
}) {
  const query = useAutomationQuery(environmentId, { op: "mcpBindings", factoryId });
  return (
    <FoundryUI.Panel className="space-y-3" aria-label="MCP runtime authorization">
      <h3 className="text-lg font-semibold">Tool access</h3>
      <p className="text-sm text-muted-foreground">
        Authorize the exact definition and its tools for this factory. A changed endpoint or command
        requires a new binding. Revocation prevents subsequent starts.
      </p>
      {query.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading tool authorizations…
        </p>
      ) : null}
      {resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">This definition does not request MCP tools.</p>
      ) : null}
      {query.error ? <FoundryUI.Notice>{query.error}</FoundryUI.Notice> : null}
      {query.result?.kind === "mcpBindings"
        ? resources.map((resource) => (
            <McpBindingEditor
              key={`${resource.id}:${query.result?.kind === "mcpBindings" ? (query.result.items.find((item) => item.resourceId === resource.id)?.generation ?? 0) : 0}`}
              environmentId={environmentId}
              factoryId={factoryId}
              resource={resource}
              binding={
                query.result?.kind === "mcpBindings"
                  ? query.result.items.find((item) => item.resourceId === resource.id)
                  : undefined
              }
              refresh={query.refresh}
            />
          ))
        : null}
    </FoundryUI.Panel>
  );
}

function McpBindingEditor({
  environmentId,
  factoryId,
  resource,
  binding,
  refresh,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  resource: FactoryV4Mcp;
  binding?: FactoryMcpBinding | undefined;
  refresh: () => void;
}) {
  const connections = [
    ...new Set(
      resource.transport === "streamable-http"
        ? resource.auth
          ? [resource.auth.connection]
          : []
        : Object.values(resource.secretEnv ?? {}),
    ),
  ];
  const [refs, setRefs] = useState<Record<string, { provider: string; reference: string }>>(() =>
    Object.fromEntries(
      connections.map((name) => [name, binding?.secrets[name] ?? { provider: "", reference: "" }]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<SetFactoryMcpBinding | null>(null);
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "setMcpBinding" }),
  );
  async function save(enabled: boolean) {
    if (busy || !allowed) return;
    let input: SetFactoryMcpBinding;
    try {
      input =
        pending ??
        decodeBinding({
          commandId: randomUUID(),
          factoryId,
          resourceId: resource.id,
          generation: (binding?.generation ?? 0) + 1,
          expectedGeneration: binding?.generation ?? null,
          enabled,
          definition: resource,
          allowedTools: resource.allowedTools,
          secrets: refs,
        });
    } catch {
      setMessage(
        "Enter a secret provider and reference for each connection. Use references to stored secrets, never secret values.",
      );
      return;
    }
    setPending(input);
    setBusy(true);
    const response = await command({ environmentId, input: { op: "setMcpBinding", input } });
    setBusy(false);
    if (AsyncResult.isSuccess(response)) {
      setPending(null);
      setMessage("Authorization saved.");
      refresh();
    } else
      setMessage(
        "Authorization was not confirmed. Retry the same request or reload the current binding.",
      );
  }
  return (
    <details className="border-b py-3 text-sm">
      <FoundryUI.Summary className="cursor-pointer">
        <span className="mr-2 font-medium">{resource.name}</span>
        <Badge variant={binding?.enabled ? "info" : "warning"}>
          {binding?.enabled ? "Binding enabled" : "Needs authorization"}
        </Badge>
      </FoundryUI.Summary>
      <div className="space-y-3 pt-3">
        <p>Tools to authorize: {resource.allowedTools.join(", ") || "None"}</p>
        <p className="break-all text-xs text-muted-foreground">
          {resource.transport === "stdio"
            ? `Local command · ${resource.command}`
            : `HTTP · ${resource.url}`}
        </p>
        {!allowed ? (
          <p role="status" className="text-sm text-muted-foreground">
            Read-only access. Tool authorization requires additional permission.
          </p>
        ) : null}
        {connections.length ? (
          <fieldset disabled={busy || pending !== null || !allowed} className="space-y-3">
            <legend className="mb-2 font-medium">Stored secret references</legend>
            <p className="text-xs text-muted-foreground">
              Select the configured secret provider by name and enter its reference path. Do not
              enter tokens or secret values.
            </p>
            {connections.map((name) => (
              <div key={name} className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{name} · Secret provider</span>
                  <Input
                    value={refs[name]?.provider ?? ""}
                    onChange={(event) =>
                      setRefs({
                        ...refs,
                        [name]: {
                          provider: event.target.value,
                          reference: refs[name]?.reference ?? "",
                        },
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{name} · Reference path</span>
                  <Input
                    value={refs[name]?.reference ?? ""}
                    onChange={(event) =>
                      setRefs({
                        ...refs,
                        [name]: {
                          provider: refs[name]?.provider ?? "",
                          reference: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </fieldset>
        ) : (
          <p className="text-xs text-muted-foreground">No secret references required.</p>
        )}
        <details>
          <FoundryUI.Summary className="cursor-pointer text-muted-foreground">
            Exact definition and binding details
          </FoundryUI.Summary>
          <p className="py-2 text-xs text-muted-foreground">
            Generation {binding?.generation ?? 0}. An enabled binding must match this exact
            definition and tool list before execution.
          </p>
          <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(resource, null, 2)}</pre>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !allowed} onClick={() => void save(true)}>
            {pending ? "Retry pending authorization" : "Authorize this exact definition"}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !allowed || !binding?.enabled || pending !== null}
            onClick={() => void save(false)}
          >
            Revoke binding
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setPending(null);
              refresh();
            }}
          >
            Reload binding
          </Button>
        </div>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </details>
  );
}
