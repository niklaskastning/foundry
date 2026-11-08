import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../components/ui/menu";
import { FoundryUI } from "./FoundryUI";
import { Link, useSearch } from "@tanstack/react-router";
import { Boxes, Inbox, Activity, Server, MessageSquare, Settings, UserRound } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { instanceCommand, initialState } from "./onboarding";
import { factoryTabs } from "./workspaceSearch";
import { useAutomationQuery } from "../features/automation/useAutomationQuery";
import { cn } from "../lib/utils";
import { useSidebar } from "../components/ui/sidebar";

const destinations = [
  { view: "factories", label: "Factories", icon: Boxes },
  { view: "inbox", label: "Decisions", icon: Inbox },
  { view: "runs", label: "Runs", icon: Activity },
  { view: "resources", label: "Resources", icon: Server },
] as const;

export function FoundrySidebar() {
  const search = useSearch({ strict: false });
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  const binding = initialState().binding;
  const [accountMessage, setAccountMessage] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const account = useAtomCommand(instanceCommand, { reportFailure: false });
  async function signOut() {
    if (signingOut || !binding) return;
    setSigningOut(true);
    const result = await account({ operation: "remove", candidate: binding });
    setSigningOut(false);
    if (AsyncResult.isSuccess(result)) window.location.assign("/foundry?view=instance");
    else setAccountMessage("Could not sign out. Open account settings to verify your session.");
  }
  const current = search.view ?? "factories";
  return (
    <div className="flex h-full min-w-0 flex-col border-r bg-sidebar px-3 pb-3 pt-14">
      <Link
        to="/"
        onClick={close}
        className="mb-6 flex items-center gap-3 rounded-md px-3 text-lg font-semibold tracking-tight"
        aria-label="Foundry home"
      >
        <Boxes className="size-5" /> Foundry
      </Link>
      <nav aria-label="Foundry workspace" className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-4">
        {destinations.map(({ view, label, icon: Icon }) => (
          <Link
            key={view}
            to="/foundry"
            search={{ view }}
            onClick={close}
            aria-current={current === view ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              current === view
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
        {binding ? (
          <SidebarFactories environmentId={binding.mainEnvironmentId} close={close} />
        ) : null}
      </nav>
      <div className="mt-auto space-y-1 border-t pt-4 text-sm text-muted-foreground">
        <Link
          to="/chats"
          onClick={close}
          className="flex items-center gap-3 rounded-lg px-3 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <MessageSquare className="size-4" />
          Chats
        </Link>
        <Link
          to="/settings/connections"
          onClick={close}
          className="flex items-center gap-3 rounded-lg px-3 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="multiline" />}>
            <UserRound className="size-4" /> Account
          </MenuTrigger>
          <MenuPopup side="top" align="start">
            {binding ? (
              <p className="max-w-64 break-all px-2 py-2 text-xs text-muted-foreground">
                {binding.origin}
              </p>
            ) : null}
            <MenuItem render={<Link to="/foundry" search={{ view: "instance" }} onClick={close} />}>
              Account & session
            </MenuItem>
            {binding ? (
              <>
                <MenuSeparator />
                <MenuItem disabled={signingOut} onClick={() => void signOut()}>
                  {signingOut ? "Signing out…" : "Sign out of Foundry"}
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
        {accountMessage ? <FoundryUI.Notice>{accountMessage}</FoundryUI.Notice> : null}
      </div>
    </div>
  );
}

function SidebarFactories({
  environmentId,
  close,
}: {
  environmentId: EnvironmentId;
  close: () => void;
}) {
  const search = useSearch({ strict: false });
  const query = useAutomationQuery(environmentId, { op: "factories", limit: 50 });
  return (
    <div className="mt-5 space-y-1 border-t pt-4">
      <p className="px-3 pb-2 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        Factory workspaces
      </p>
      {query.loading ? (
        <p role="status" className="px-3 text-xs">
          Loading factories…
        </p>
      ) : null}
      {query.error ? (
        <p role="status" className="px-3 text-xs">
          {query.error}
        </p>
      ) : null}
      {query.result?.kind === "factories"
        ? query.result.items.map((factory) => (
            <details key={factory.id} open={search.factoryId === factory.id || undefined}>
              <FoundryUI.Summary className="cursor-pointer truncate rounded-lg px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                {factory.name}
              </FoundryUI.Summary>
              <div className="ml-4 border-l pl-2">
                {factoryTabs.map((tab) => (
                  <Link
                    key={tab}
                    to="/foundry"
                    search={{ view: "factories", factoryId: factory.id, tab }}
                    onClick={close}
                    aria-current={
                      search.factoryId === factory.id && (search.tab ?? "overview") === tab
                        ? "page"
                        : undefined
                    }
                    className="block rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary"
                  >
                    {tab === "agents"
                      ? "Agents & skills"
                      : tab === "work"
                        ? "Work items"
                        : tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Link>
                ))}
                <Link
                  to="/foundry"
                  search={{ view: "inbox", factoryId: factory.id }}
                  onClick={close}
                  className="block rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  Decisions
                </Link>
              </div>
            </details>
          ))
        : null}
      {query.result?.kind === "factories" && query.result.next ? (
        <Link
          to="/foundry"
          search={{ view: "factories" }}
          onClick={close}
          className="block px-3 py-2 text-sm underline"
        >
          Find more factories
        </Link>
      ) : null}
    </div>
  );
}
