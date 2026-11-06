import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type FoundrySandboxProfileSummary } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { sandboxCommands } from "./sandboxes";

export function useSandboxProfiles(environmentId: EnvironmentId | undefined) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(sandboxCommands.query.permissionAtom(environmentId ?? null));
  const [state, setState] = useState<{
    environmentId: EnvironmentId;
    supported: boolean;
    profiles: ReadonlyArray<FoundrySandboxProfileSummary>;
    error?: string;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Discover Main's actual sandbox capability and authorized immutable profiles for this connection.
  useEffect(() => {
    if (!environmentId || !canRead) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const result = await runAtomCommand(
          registry,
          sandboxCommands.query,
          { environmentId, input: { action: "list" } },
          { reportFailure: false },
        );
        if (abort.signal.aborted) return;
        if (AsyncResult.isSuccess(result) && "profiles" in result.value)
          setState({
            environmentId,
            supported: result.value.sandboxSupported === true,
            profiles: result.value.profiles.filter((profile) => profile.enabled),
          });
        else
          setState({
            environmentId,
            supported: false,
            profiles: [],
            error: "Sandbox profiles unavailable. Reopen this view to retry.",
          });
      } catch {
        if (!abort.signal.aborted) setState({ environmentId, supported: false, profiles: [] });
      }
    })();
    return () => abort.abort();
  }, [environmentId, canRead, registry]);
  return canRead && state?.environmentId === environmentId ? state : undefined;
}
