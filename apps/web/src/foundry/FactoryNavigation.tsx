import { useEffect, useState } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { EnvironmentId, ThreadId, FoundryDescriptor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { initialState } from "./onboarding";

import { useAutomationQuery } from "../features/automation/useAutomationQuery";

const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);

export function useAutomationAvailable(bindingOverride?: string) {
  const bindingId = bindingOverride ?? initialState().binding?.instanceId;
  const [available, setAvailable] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Discover the connected Main capability before exposing automation navigation.
  useEffect(() => {
    const abort = new AbortController();
    if (bindingId)
      void fetch("/.well-known/foundry?protocolVersion=1", {
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
      })
        .then((response) => response.json())
        .then((value: unknown) => {
          const descriptor = decodeDescriptor(value);
          if (!abort.signal.aborted) setAvailable(descriptor.automation?.protocolVersion === "1");
        })
        .catch(() => {});
    return () => abort.abort();
  }, [bindingId]);
  return available;
}
export function FactoryNavigation() {
  const available = useAutomationAvailable();
  if (!available) return null;
  return (
    <nav aria-label="Foundry instance" className="flex flex-wrap gap-3 px-2 py-2 text-sm">
      <span className="text-muted-foreground">Instance</span>
      <Link to="/foundry" search={{ view: "factories" }}>
        Factories
      </Link>
      <Link to="/foundry" search={{ view: "runs" }}>
        Runs
      </Link>
      <Link to="/foundry" search={{ view: "inbox" }}>
        Inbox
      </Link>
    </nav>
  );
}

export function FactoryRunReturn() {
  const search = useSearch({ strict: false });
  const params = useParams({ strict: false });
  const binding = initialState().binding;
  if (binding && params.environmentId && params.threadId)
    return (
      <ThreadHandoffReturn
        key={`${binding.mainEnvironmentId}:${params.environmentId}:${params.threadId}`}
        mainEnvironmentId={binding.mainEnvironmentId}
        environmentId={EnvironmentId.make(params.environmentId)}
        threadId={ThreadId.make(params.threadId)}
        fallback={
          search.factoryId && search.runId
            ? { factoryId: search.factoryId, runId: search.runId }
            : null
        }
      />
    );
  if (!search.factoryId || !search.runId) return null;
  return (
    <div className="border-b px-5 py-2 text-sm">
      <Link
        className="underline"
        to="/foundry"
        search={{ view: "runs", factoryId: search.factoryId, runId: search.runId }}
      >
        Back to factory run
      </Link>
    </div>
  );
}

function ThreadHandoffReturn({
  mainEnvironmentId,
  environmentId,
  threadId,
  fallback,
}: {
  mainEnvironmentId: EnvironmentId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  fallback: { factoryId: string; runId: string } | null;
}) {
  const query = useAutomationQuery(mainEnvironmentId, {
    op: "threadHandoff",
    environmentId,
    threadId,
  });
  const handoff = !query.error && query.result?.kind === "handoff" ? query.result.handoff : null;
  if (handoff)
    return (
      <div className="border-b px-5 py-2 text-sm">
        <Link
          className="underline"
          to="/foundry"
          search={{
            view: "factories",
            factoryId: handoff.factoryId,
            workItemId: handoff.workItemId,
          }}
        >
          Back to work item · {handoff.state === "open" ? "Return to factory" : handoff.state}
        </Link>
      </div>
    );
  if (!fallback) return null;
  return (
    <div className="border-b px-5 py-2 text-sm">
      <Link className="underline" to="/foundry" search={{ view: "runs", ...fallback }}>
        Back to factory run
      </Link>
    </div>
  );
}
