import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StandalonePage } from "../components/ui/standalone-page";
import { useAtomCommand } from "../state/use-atom-command";
import {
  instanceCommand,
  instanceEntry,
  initialState,
  type OnboardingResult,
  type Operation,
} from "./onboarding";

export function FoundryPage() {
  const [origin, setOrigin] = useState(window.location.origin);
  const [state, setState] = useState<OnboardingResult>(initialState);
  const [message, setMessage] = useState(state.message);
  const [busy, setBusy] = useState(false);
  const run = useAtomCommand(instanceCommand, { reportFailure: false });

  async function operate(operation: Operation) {
    setBusy(true);
    const result = await run({
      operation,
      ...(state?.binding ? { candidate: state.binding } : {}),
    });
    if (AsyncResult.isSuccess(result)) {
      setState(result.value);
      setOrigin(result.value.binding?.origin ?? window.location.origin);
      setMessage(result.value.message);
    } else {
      setState({ ...initialState(), session: null });
      const failure = squashAtomCommandFailure(result);
      setMessage(
        failure instanceof Error ? failure.message : "The operation failed. Retry verification.",
      );
    }
    setBusy(false);
  }

  const nativeTransport = new URLSearchParams(window.location.search).get("desktop") === "1";

  function openOrigin() {
    try {
      window.location.assign(instanceEntry(origin));
    } catch {
      setMessage("Enter an HTTPS origin without a path, credentials, query or fragment.");
    }
  }

  return (
    <StandalonePage>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Foundry instance</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to your Main instance. Device access is available in connection settings when
            this Main supports the device catalog.
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="foundry-origin" className="text-sm font-medium">
            Instance URL
          </label>
          <Input
            id="foundry-origin"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            disabled={busy || state.confirmed || nativeTransport}
            placeholder="https://foundry.example.com"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={openOrigin}
              disabled={busy || state.confirmed || nativeTransport}
            >
              Open URL
            </Button>
            <Button onClick={() => void operate("inspect")} disabled={busy}>
              Verify current origin
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The browser opens the chosen origin for Access sign-in. Remove the current Foundry
            session before switching. No credentials are forwarded to another origin.
          </p>
        </div>
        {state?.binding ? (
          <div className="space-y-1 break-all text-sm">
            <p>Origin: {state.binding.origin}</p>
            <p>Instance ID: {state.binding.instanceId}</p>
            <p>Issuer: {state.binding.issuer}</p>
            <p>Main environment: {state.binding.mainEnvironmentId}</p>
            {!state.confirmed ? (
              <div className="pt-2">
                <Button disabled={busy} onClick={() => void operate("confirm")}>
                  Confirm this identity
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {state?.confirmed ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void operate("login")}>
              Sign in to Foundry
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void operate("session")}>
              Check session
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void operate("refresh")}>
              Refresh session
            </Button>
            {!nativeTransport ? (
              <Button variant="outline" disabled={busy} onClick={() => void operate("remove")}>
                Sign out and remove
              </Button>
            ) : null}
          </div>
        ) : null}
        {nativeTransport ? (
          <p className="text-sm text-muted-foreground">
            Close this window to refresh the desktop Access grant, remove or switch instances using
            the desktop controls.
          </p>
        ) : (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Forget only the local identity? This does not revoke a remote session. Use this recovery action only after verifying the instance with its operator.",
                )
              )
                void operate("forget");
            }}
          >
            Forget local identity without revocation…
          </Button>
        )}
        <p role="status" className="text-sm">
          {busy ? "Checking instance…" : message}
        </p>
        {state?.session ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm">
              Foundry session verified until {new Date(state.session.expiresAt).toLocaleString()}.
              T3 connection status is shown in the environment view.
            </p>
            <Button onClick={() => window.location.assign("/settings/connections")}>
              Open connection settings
            </Button>
            <p className="text-xs text-muted-foreground">
              A Main T3 session is still required in addition to Foundry sign-in. Device selection
              uses the existing connection manager; a Foundry session alone does not grant device
              access.
            </p>
          </div>
        ) : null}
      </div>
    </StandalonePage>
  );
}
