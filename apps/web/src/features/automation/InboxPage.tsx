import { FoundryUI } from "../../foundry/FoundryUI";
import { useContext, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AutomationInboxEntry, AutomationInboxQuery, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { Badge } from "../../components/ui/badge";
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
  const kind = compact ? undefined : navigation.search.inboxKind;
  const status = compact ? "open" : (navigation.search.inboxStatus ?? "open");
  const unreadOnly = !compact && navigation.search.inboxUnread === "1";
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
  const readable = canRead && sessionHasScope(session, "orchestration:read");
  const visibleItems = current && readable ? items : [];
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
    <section
      className={
        compact
          ? "min-w-0 space-y-4 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
          : "min-w-0 space-y-6"
      }
      aria-label="Personal inbox"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {compact ? (
            <FoundryUI.Heading>Needs your attention</FoundryUI.Heading>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">Decisions</h1>
          )}
          <p className="text-sm text-muted-foreground">
            Review results, answer questions and unblock work.
          </p>
        </div>
        <Button variant="outline" disabled={busy || !canRead} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {!compact ? (
        <div className="flex flex-wrap items-end gap-3">
          <ListFilters
            environmentId={environmentId}
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
            <span className="text-xs text-muted-foreground">Type</span>
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
              <SelectTrigger aria-label="Filter by decision type">
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
      {!canRead || !sessionHasScope(session, "orchestration:read") ? (
        <p role="status" className="text-sm">
          Connect to Main with read permission to open your inbox.
        </p>
      ) : null}
      <div
        className={
          selected
            ? "grid items-start gap-4 xl:grid-cols-[minmax(16rem,2fr)_minmax(0,3fr)]"
            : "space-y-4"
        }
      >
        <div className="space-y-3">
          <ul
            className={
              visibleItems.length
                ? "divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
                : undefined
            }
            aria-label="Inbox items"
          >
            {visibleItems.map((item) => (
              <li
                key={item.id}
                className={selectedId === item.id ? "bg-accent/50 px-4 py-3" : "px-4 py-3"}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm font-medium">{item.title}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          item.kind === "error" || item.kind === "blocker"
                            ? "error"
                            : item.active && !item.isDone
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {item.kind}
                      </Badge>
                      {!item.isRead ? <span className="text-xs font-medium">Unread</span> : null}
                    </div>
                    <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                      {item.detail === "iterations_exhausted"
                        ? "Review rounds reached their limit. Inspect the last result before continuing."
                        : item.detail}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.isDone
                        ? "Done in your inbox"
                        : item.active
                          ? item.kind === "approval"
                            ? "Approval required"
                            : item.kind === "question"
                              ? "Answer required"
                              : "Needs attention"
                          : "Resolved"}
                      {item.stepId ? ` · Step ${item.stepId}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    aria-pressed={selectedId === item.id}
                    onClick={() => setSelectedId(item.id)}
                  >
                    {item.active && !item.isDone
                      ? item.kind === "question"
                        ? "Answer"
                        : "Review"
                      : "View"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {readable && current && !message && visibleItems.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-5">
              <p className="text-sm font-medium">
                {compact ? "No open decisions" : "No decisions match these filters"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {compact
                  ? "Questions, approvals and blockers will appear here."
                  : "Try another status or factory to find earlier decisions."}
              </p>
            </div>
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
      {readable && (!current || message) ? (
        <p role={message ? "alert" : "status"} className="text-sm text-muted-foreground">
          {!current ? "Loading inbox…" : message}
        </p>
      ) : null}
    </section>
  );
}
