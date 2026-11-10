import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "../components/ui/button";
import { NewThreadLinkView } from "../components/promptLinks/NewThreadLinkView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

// The query is read raw: the router's own search parsing turns `prompt=123` into a number.
function NewThreadLinkRoute() {
  const search = useLocation({ select: (location) => location.searchStr });
  const parsed = parseNewThreadLink(search);
  if (!parsed.ok) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Could not open the link</EmptyTitle>
            <EmptyDescription>{parsed.error}</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => openCommandPalette({ open: "new-thread-in" })}>
            Start a new chat
          </Button>
          <Button render={<Link to="/" />} variant="outline">
            Return to workspace
          </Button>
        </Empty>
      </SidebarInset>
    );
  }
  return <NewThreadLinkView key={search} link={parsed.value} />;
}

export const Route = createFileRoute("/_chat/new")({
  component: NewThreadLinkRoute,
});
