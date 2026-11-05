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
import { Textarea } from "../../components/ui/textarea";
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
    <section className="space-y-3" aria-label="MCP runtime authorization">
      <h3 className="font-medium">MCP runtime authorization</h3>
      <p className="text-sm">
        Authorize the exact definition and its tools for this factory. A changed endpoint or command
        requires a new binding. Revocation prevents subsequent starts.
      </p>
      {query.error ? <p role="alert">{query.error}</p> : null}
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
    </section>
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
  const [refs, setRefs] = useState(JSON.stringify(binding?.secrets ?? {}, null, 2));
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
          secrets: JSON.parse(refs),
        });
    } catch {
      setMessage(
        "Enter a JSON mapping from connection names to {provider, reference}. Never enter secret values.",
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
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer">
        {resource.name} ·{" "}
        {binding?.enabled ? `Authorized binding ${binding.generation}` : "Not authorized"}
      </summary>
      <div className="space-y-3 pt-3">
        <p>Tools to authorize: {resource.allowedTools.join(", ") || "None"}</p>
        <pre className="max-h-64 overflow-auto">{JSON.stringify(resource, null, 2)}</pre>
        <label className="block space-y-1">
          <span>Secret-provider references only (JSON; no secret values)</span>
          <Textarea
            value={refs}
            disabled={busy || pending !== null || !allowed}
            onChange={(event) => setRefs(event.target.value)}
          />
        </label>
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
