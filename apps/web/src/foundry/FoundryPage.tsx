import { FoundryUI } from "./FoundryUI";
import { instanceReturnPath } from "./home";
import { useFoundrySession } from "./useFoundrySession";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import { FactoryNavigation, useAutomationCapability } from "./FactoryNavigation";
import { hasConfirmedAutomationView } from "./pageMode";
import { lazy, Suspense, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StandalonePage } from "../components/ui/standalone-page";
import { useAtomCommand } from "../state/use-atom-command";
import { DeviceCatalog } from "./DeviceCatalog";
import { useSandboxProfiles } from "./useSandboxProfiles";
import { WorkerCapacity } from "../features/automation/WorkerCapacity";
import { instanceCommand, instanceEntry, initialState, type Operation } from "./onboarding";

const ThreadArchiveLibrary = lazy(() =>
  import("./ThreadArchiveLibrary").then((module) => ({ default: module.ThreadArchiveLibrary })),
);
const SandboxPanel = lazy(() =>
  import("../components/foundry/SandboxPanel").then((module) => ({ default: module.SandboxPanel })),
);

const ArtifactLibrary = lazy(() =>
  import("./ArtifactLibrary").then((module) => ({ default: module.ArtifactLibrary })),
);

const FactoryPage = lazy(() =>
  import("../features/automation/FactoryPage").then((module) => ({ default: module.FactoryPage })),
);
const InboxPage = lazy(() =>
  import("../features/automation/InboxPage").then((module) => ({ default: module.InboxPage })),
);
export function FoundryPage() {
  const search = useSearch({ from: "/foundry" });
  const navigate = useNavigate({ from: "/foundry" });
  const [origin, setOrigin] = useState(window.location.origin);
  const [state, setState] = useFoundrySession();
  const capability = useAutomationCapability(state.binding?.instanceId);
  const sandboxes = useSandboxProfiles(state.binding?.mainEnvironmentId);
  const [message, setMessage] = useState(state.message);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const run = useAtomCommand(instanceCommand, { reportFailure: false });

  async function operate(operation: Operation) {
    setBusy(true);
    const result = await run({
      operation,
      ...(operation === "login" ? { credentials: { username, password } } : {}),
      ...(state?.binding ? { candidate: state.binding } : {}),
    });
    setPassword("");
    if (AsyncResult.isSuccess(result)) {
      if (result.value.session && !state.session) {
        window.location.assign(
          instanceReturnPath(
            search.returnTo ??
              (search.view === "instance"
                ? undefined
                : window.location.pathname + window.location.search),
          ),
        );
        return;
      }
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

  if (hasConfirmedAutomationView(search.view, state) && capability !== "available") {
    return (
      <main className="min-w-0 flex-1 p-8 pt-20" aria-label="Factory workspace">
        <h1 className="text-xl font-semibold">Factories</h1>
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {capability === "loading"
            ? "Connecting to your factory workspace…"
            : capability === "unsupported"
              ? "This instance does not support Factories."
              : "Could not verify the instance capability. Check your connection and retry."}
        </p>
        {capability !== "loading" ? (
          <div className="mt-4">
            <Button onClick={() => window.location.reload()}>Retry connection</Button>
          </div>
        ) : null}
      </main>
    );
  }
  if (capability === "available" && state.binding && hasConfirmedAutomationView(search.view, state))
    return (
      <main
        id="foundry-content"
        aria-label="Factory workspace"
        tabIndex={-1}
        className="h-dvh min-w-0 flex-1 overflow-y-auto scrollbar-gutter-both bg-muted/20 text-foreground pt-12"
      >
        <div className="mx-auto max-w-7xl">
          <Suspense fallback={<p>Loading…</p>}>
            {search.view === "resources" ? (
              <div className="space-y-8 p-4 sm:p-6 lg:p-8">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Instance
                  </p>
                  <h1 className="mt-1 text-2xl font-semibold">Resources</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Instance-wide worker inventory and execution capacity. Configure interactive
                    connections in Settings → Connections; configure workflow access in each
                    Factory.
                  </p>
                </div>
                <FoundryUI.Panel aria-label="Resource settings">
                  <FoundryUI.Heading>Configuration by scope</FoundryUI.Heading>
                  <div className="grid gap-5 text-sm sm:grid-cols-3">
                    <div className="space-y-2">
                      <h3 className="font-medium">Instance & machines</h3>
                      <p className="leading-6 text-muted-foreground">
                        Manage registered machines and execution capacity below.
                      </p>
                      <Link
                        className="inline-flex min-h-9 items-center rounded-md underline underline-offset-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        to="/settings/connections"
                      >
                        Interactive connections
                      </Link>
                    </div>
                    <div className="space-y-2">
                      <h3 className="font-medium">Factory</h3>
                      <p className="leading-6 text-muted-foreground">
                        Definitions, workflows and authorized MCP bindings belong to their Factory.
                      </p>
                      <Link
                        className="inline-flex min-h-9 items-center rounded-md underline underline-offset-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        to="/foundry"
                        search={{ view: "factories" }}
                      >
                        Choose a Factory
                      </Link>
                    </div>
                    <div className="space-y-2">
                      <h3 className="font-medium">Interactive work</h3>
                      <p className="leading-6 text-muted-foreground">
                        Provider and project settings apply to the selected environment.
                      </p>
                      <Link
                        className="inline-flex min-h-9 items-center rounded-md underline underline-offset-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        to="/settings/providers"
                      >
                        Provider settings
                      </Link>
                    </div>
                  </div>
                </FoundryUI.Panel>
                <WorkerCapacity environmentId={state.binding.mainEnvironmentId} />
                <DeviceCatalog readinessInDetails />
                {sandboxes?.supported ? (
                  <SandboxPanel environmentId={state.binding.mainEnvironmentId} />
                ) : null}
              </div>
            ) : search.view === "inbox" ? (
              <div className="p-4 sm:p-6 lg:p-8">
                <InboxPage
                  environmentId={state.binding.mainEnvironmentId}
                  {...(search.factoryId ? { factoryId: search.factoryId } : {})}
                  onNavigateRun={(factoryId, runId) =>
                    void navigate({ search: { view: "factories", factoryId, runId, tab: "runs" } })
                  }
                  onNavigateWorkItem={(factoryId, workItemId) =>
                    void navigate({
                      search: { view: "factories", factoryId, workItemId, tab: "work" },
                    })
                  }
                />
              </div>
            ) : (
              <FactoryPage
                key={`${search.view}:${search.factoryId}`}
                environmentId={state.binding.mainEnvironmentId}
                initialView={
                  search.view === "runs" ? "runs" : search.view === "work" ? "work" : "factories"
                }
                {...(search.factoryId ? { factoryId: search.factoryId } : {})}
                {...(search.runId ? { initialRunId: search.runId } : {})}
                {...(search.workItemId ? { initialWorkItemId: search.workItemId } : {})}
              />
            )}
          </Suspense>
        </div>
      </main>
    );
  return (
    <StandalonePage>
      <div className="space-y-5">
        <FactoryNavigation />
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Instance access
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {state.session ? "Connected to Foundry" : "Connect to your factory workspace"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Verify your instance, then sign in to open its factories and connected workers.
          </p>
        </div>
        <div className="space-y-2">
          <details open={nativeTransport || undefined}>
            <FoundryUI.Summary className="cursor-pointer text-sm">
              {nativeTransport ? "Instance URL" : "Use another instance"}
            </FoundryUI.Summary>
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
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
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
          <div className="space-y-3 text-sm">
            <p className="break-all font-medium">{state.binding.origin}</p>
            <details className="rounded-lg border p-3">
              <FoundryUI.Summary className="cursor-pointer text-muted-foreground">
                Verified instance identity
              </FoundryUI.Summary>
              <div className="space-y-1 break-all pt-3 text-xs text-muted-foreground">
                <p>Instance ID: {state.binding.instanceId}</p>
                <p>Issuer: {state.binding.issuer}</p>
                <p>Main environment: {state.binding.mainEnvironmentId}</p>
              </div>
            </details>
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
            {!state.session ? (
              <form
                className="grid w-full max-w-sm gap-4 rounded-xl border bg-card p-4 sm:p-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void operate("login");
                }}
              >
                {state.nativeLoginAvailable ? (
                  <fieldset disabled={busy} className="space-y-4">
                    <legend className="sr-only">Foundry account</legend>
                    <div className="space-y-2">
                      <label htmlFor="foundry-username" className="text-sm font-medium">Account</label>
                      <Input
                        id="foundry-username"
                        name="username"
                        autoComplete="username"
                        required
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="foundry-password" className="text-sm font-medium">Password</label>
                      <Input
                        id="foundry-password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </div>
                  </fieldset>
                ) : null}
                <Button type="submit" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in to Foundry"}
                </Button>
              </form>
            ) : (
              <Button onClick={() => window.location.assign("/foundry?view=factories")}>
                Open factories
              </Button>
            )}
            <details className="w-full rounded-lg border p-3">
              <FoundryUI.Summary className="cursor-pointer text-sm text-muted-foreground">
                Session controls
              </FoundryUI.Summary>
              <div className="flex flex-wrap gap-2 pt-3">
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
            </details>
          </div>
        ) : null}
        {nativeTransport ? (
          <p className="text-sm text-muted-foreground">
            Close this window to refresh the desktop Access grant, remove or switch instances using
            the desktop controls.
          </p>
        ) : (
          <details className="text-sm">
            <FoundryUI.Summary className="cursor-pointer text-muted-foreground">
              Connection recovery
            </FoundryUI.Summary>
            <div className="pt-2">
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
            </div>
          </details>
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
              Authorized machines are loaded automatically. Interactive access and Factory execution
              permissions are managed separately for each machine.
            </p>
          </div>
        ) : null}
        {state?.session && state.artifactsAvailable && !nativeTransport ? (
          <Suspense fallback={<p className="text-sm">Loading files…</p>}>
            <ArtifactLibrary />
            {state.archivesAvailable ? (
              <ThreadArchiveLibrary
                {...(search.archiveEnvironmentId && search.archiveThreadId
                  ? {
                      initialOwner: {
                        environmentId: EnvironmentId.make(search.archiveEnvironmentId),
                        threadId: ThreadId.make(search.archiveThreadId),
                      },
                    }
                  : {})}
              />
            ) : null}
          </Suspense>
        ) : null}
      </div>
    </StandalonePage>
  );
}
