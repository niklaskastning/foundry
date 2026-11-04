import { useEffect, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { FoundryDescriptor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { initialState } from "./onboarding";

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
    <nav aria-label="Foundry" className="flex flex-wrap gap-3 px-2 py-2 text-sm">
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
