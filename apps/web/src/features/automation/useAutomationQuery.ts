import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AutomationApplicationQuery,
  AutomationApplicationResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { environmentSession, sessionHasScope } from "../../state/session";
import { automationCommands } from "./commands";

export function useAutomationQuery(
  environmentId: EnvironmentId,
  input: AutomationApplicationQuery,
) {
  const registry = useContext(RegistryContext);
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const live =
    input.op === "run" ||
    input.op === "runs" ||
    input.op === "workItems" ||
    input.op === "attempts" ||
    input.op === "handoffs";
  const [generation, setGeneration] = useState(0);
  const key = JSON.stringify({ input, generation });
  const queryKey = JSON.stringify({ environmentId, input });
  const [responseKey, setResponseKey] = useState<string>();
  const [result, setResult] = useState<AutomationApplicationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize durable server data on navigation, refresh and browser reconnection.
  useEffect(() => {
    if (!sessionHasScope(session, "orchestration:read")) return;
    let disposed = false;
    let inFlight = false;
    let latest = 0;
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      latest = latest + 1;
      const sequence = latest;
      setLoading(true);
      const response = await runAtomCommand(
        registry,
        automationCommands.query,
        { environmentId, input: JSON.parse(key).input },
        { reportFailure: false },
      );
      inFlight = false;
      if (disposed || sequence !== latest) return;
      setResponseKey(queryKey);
      if (AsyncResult.isSuccess(response)) {
        setResult(response.value);
        setError(null);
      } else {
        setResult(null);
        const failure = squashAtomCommandFailure(response);
        setError(failure instanceof Error ? failure.message : "Unable to load factory data.");
      }
      setLoading(false);
    };
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", load);
    const timer = live ? window.setInterval(load, 5000) : undefined;
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", load);
      window.clearInterval(timer);
    };
  }, [registry, environmentId, key, queryKey, session, live]);
  const allowed = sessionHasScope(session, "orchestration:read");
  return {
    result: allowed && responseKey === queryKey ? result : null,
    error: allowed
      ? responseKey === queryKey
        ? error
        : null
      : "A current Main session with read permission is required.",
    loading: allowed && (loading || responseKey !== queryKey),
    refresh: () => setGeneration((value) => value + 1),
  };
}
