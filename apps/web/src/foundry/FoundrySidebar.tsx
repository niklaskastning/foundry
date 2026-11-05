import { Link, useSearch } from "@tanstack/react-router";
import { Boxes, ListTodo, Inbox, Activity, Server, MessageSquare, Settings } from "lucide-react";
import { cn } from "../lib/utils";
import { useSidebar } from "../components/ui/sidebar";

const destinations = [
  { view: "factories", label: "Factories", icon: Boxes },
  { view: "work", label: "Work", icon: ListTodo },
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
  const current = search.view ?? "factories";
  return (
    <div className="flex h-full flex-col px-3 pb-4 pt-14">
      <Link
        to="/"
        onClick={close}
        className="mb-8 flex items-center gap-2 px-3 text-lg font-semibold tracking-tight"
        aria-label="Foundry home"
      >
        <Boxes className="size-5" /> Foundry
      </Link>
      <nav aria-label="Foundry workspace" className="space-y-1">
        {destinations.map(({ view, label, icon: Icon }) => (
          <Link
            key={view}
            to="/foundry"
            search={{ view }}
            onClick={close}
            aria-current={current === view ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              current === view
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto space-y-1 border-t pt-4 text-sm text-muted-foreground">
        <Link
          to="/chats"
          onClick={close}
          className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent"
        >
          <MessageSquare className="size-4" />
          Chats
        </Link>
        <Link
          to="/settings/connections"
          onClick={close}
          className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent"
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <Link
          to="/foundry"
          search={{ view: "instance" }}
          onClick={close}
          className="block px-3 py-2 text-xs"
        >
          Instance & sign-in
        </Link>
      </div>
    </div>
  );
}
