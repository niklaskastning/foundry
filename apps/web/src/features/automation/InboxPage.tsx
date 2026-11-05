import { useContext, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AutomationInboxEntry, AutomationInboxQuery, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { Button } from "../../components/ui/button";
import { ListFilters } from "./ListFilters";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { environmentSession, sessionHasScope } from "../../state/session";
import { automationCommands } from "./commands";
import { InboxDetail } from "./InboxDetail";

export function InboxPage({
  environmentId,
  factoryId,
  onNavigateRun,
  onNavigateWorkItem,
  compact = false,
}: {
  environmentId: EnvironmentId;
  factoryId?: string;
  compact?: boolean;
  onNavigateRun?: (factoryId: string, runId: string) => void;
  onNavigateWorkItem?: (factoryId: string, workItemId: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const canRead = useAtomValue(automationCommands.inboxQuery.permissionAtom(environmentId));
  const navigation = useWorkspaceNavigation();
  const kind = navigation.search.inboxKind;
  const status = compact ? "open" : (navigation.search.inboxStatus ?? "open");
  const unreadOnly = navigation.search.inboxUnread === "1";
  const filterFactory = factoryId ?? navigation.search.filterFactory ?? "";
  const cursor = compact ? undefined : navigation.search.inboxCursor;
  const setCursor = (inboxCursor?: string) => navigation.update({ inboxCursor });
  const [generation, setGeneration] = useState(0);
  const [items, setItems] = useState<readonly AutomationInboxEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const selectedId = navigation.search.inboxId;
  const setSelectedId = (inboxId: string | null) =>
    navigation.update({ inboxId: inboxId ?? undefined });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const queryKey = JSON.stringify({
    environmentId,
    compact,
    filterFactory,
    kind,
    status,
    unreadOnly,
    cursor,
  });
  const [responseKey, setResponseKey] = useState<string>();
  const current = responseKey === queryKey;
  const visibleItems =
    current && canRead && sessionHasScope(session, "orchestration:read") ? items : [];
  const selected = visibleItems.find((item) => item.id === selectedId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reload durable inbox facts after navigation, browser reconnection, focus or an explicit refresh.
  useEffect(() => {
    if (!canRead || !sessionHasScope(session, "orchestration:read")) return;
    let inFlight = false;
    let disposed = false;
    let latest = generation;
    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      latest = latest + 1;
      const sequence = latest;
      setBusy(true);
      const input: AutomationInboxQuery = {
        status,
        unreadOnly,
        ...(factoryId || filterFactory ? { factoryId: factoryId || filterFactory } : {}),
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
        limit: compact ? 5 : 30,
      };
      const result = await runAtomCommand(
        registry,
        automationCommands.inboxQuery,
        { environmentId, input },
        { reportFailure: false },
      );
      inFlight = false;
      if (disposed || sequence !== latest) return;
      setBusy(false);
      setResponseKey(queryKey);
      if (AsyncResult.isSuccess(result)) {
        setItems(result.value.items);
        setNextCursor(result.value.nextCursor);
        setMessage("");
      } else {
        setItems([]);
        setNextCursor(null);
        setMessage("Inbox could not be loaded. Check your Main connection and refresh.");
      }
    };
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", load);
    const timer = window.setInterval(load, 5000);
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", load);
      window.clearInterval(timer);
    };
  }, [
    compact,
    queryKey,
    registry,
    environmentId,
    canRead,
    session,
    factoryId,
    filterFactory,
    kind,
    status,
    unreadOnly,
    cursor,
    generation,
  ]);
  const refresh = () => setGeneration((value) => value + 1);
  return (
    <section className="space-y-4" aria-label="Personal inbox">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{compact ? "Next decisions" : "Inbox"}</h1>
          <p className="text-sm text-muted-foreground">
            Questions, decisions and problems from your factory runs.
          </p>
        </div>
        <Button variant="outline" disabled={busy || !canRead} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {!compact ? (
        <div className="flex flex-wrap items-end gap-3">
          <ListFilters
            factoryId={factoryId ?? filterFactory}
            {...(!factoryId
              ? {
                  onFactoryChange: (value: string) => {
                    navigation.update({
                      filterFactory: value,
                      inboxCursor: undefined,
                      inboxId: undefined,
                    });
                  },
                }
              : {})}
            state={status}
            states={["open", "done", "all"] as const}
            onStateChange={(value) => {
              navigation.update({ inboxStatus: value, inboxCursor: undefined, inboxId: undefined });
            }}
          />
          <label className="space-y-1">
            <span className="text-sm">Type</span>
            <Select
              value={kind ?? "all"}
              onValueChange={(value) => {
                navigation.update({
                  inboxKind: value === "all" ? undefined : (value as AutomationInboxQuery["kind"]),
                  inboxCursor: undefined,
                  inboxId: undefined,
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="question">Questions</SelectItem>
                <SelectItem value="answer">Answers</SelectItem>
                <SelectItem value="approval">Approvals</SelectItem>
                <SelectItem value="blocker">Blockers</SelectItem>
                <SelectItem value="error">Errors</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => {
                navigation.update({
                  inboxUnread: event.target.checked ? "1" : undefined,
                  inboxCursor: undefined,
                  inboxId: undefined,
                });
              }}
            />
            Unread only
          </label>
        </div>
      ) : null}
      {!canRead ? (
        <p role="status" className="text-sm">
          Connect to Main with read permission to open your inbox.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="Inbox items">
            {visibleItems.map((item) => (
              <li key={item.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.isRead ? "Read" : "Unread"} ·{" "}
                      {item.isDone ? "Done" : item.active ? "Open" : "Resolved"} · {item.factoryId}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    aria-pressed={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  >
                    Details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {canRead && current && !busy && visibleItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching inbox items.</p>
          ) : null}
          {!compact ? (
            <div className="flex gap-2">
              {cursor ? (
                <Button variant="outline" disabled={busy} onClick={() => setCursor(undefined)}>
                  First page
                </Button>
              ) : null}
              {current && nextCursor ? (
                <Button variant="outline" disabled={busy} onClick={() => setCursor(nextCursor)}>
                  Next page
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {selected ? (
          <InboxDetail
            key={`${selected.id}:${selected.sourceRevision}:${selected.isRead}:${selected.isDone}`}
            environmentId={environmentId}
            item={selected}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
            {...(onNavigateRun ? { onNavigateRun } : {})}
            {...(onNavigateWorkItem ? { onNavigateWorkItem } : {})}
          />
        ) : null}
      </div>
      {busy || !current || message ? (
        <p role="status" className="text-sm">
          {busy || !current ? "Loading inbox…" : message}
        </p>
      ) : null}
    </section>
  );
}
