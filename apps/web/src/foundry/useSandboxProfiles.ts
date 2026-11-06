import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  FoundryDescriptor,
  type EnvironmentId,
  type FoundrySandboxProfile,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useContext, useEffect, useState } from "react";
import { sandboxCommands } from "./sandboxes";

const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);
export function useSandboxProfiles(environmentId: EnvironmentId | undefined) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(sandboxCommands.query.permissionAtom(environmentId ?? null));
  const [state, setState] = useState<{
    environmentId: EnvironmentId;
    supported: boolean;
    profiles: ReadonlyArray<FoundrySandboxProfile>;
    error?: string;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Discover Main's actual sandbox capability and authorized immutable profiles for this connection.
  useEffect(() => {
    if (!environmentId || !canRead) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/.well-known/foundry?protocolVersion=1", {
          signal: abort.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!abort.signal.aborted) setState({ environmentId, supported: false, profiles: [] });
          return;
        }
        const supported =
          decodeDescriptor(await response.json()).sandboxes?.protocolVersion === "1";
        if (!supported) {
          if (!abort.signal.aborted) setState({ environmentId, supported, profiles: [] });
          return;
        }
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
            supported,
            profiles: result.value.profiles.filter((profile) => profile.enabled),
          });
        else
          setState({
            environmentId,
            supported,
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
