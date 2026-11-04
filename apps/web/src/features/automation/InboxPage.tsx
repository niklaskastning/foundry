import { useContext, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AutomationInboxEntry, AutomationInboxQuery, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { ListFilters } from "./ListFilters";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { automationCommands } from "./commands";
import { InboxDetail } from "./InboxDetail";

export function InboxPage({
  environmentId,
  factoryId,
  onNavigateRun,
  onNavigateWorkItem,
}: {
  environmentId: EnvironmentId;
  factoryId?: string;
  onNavigateRun?: (factoryId: string, runId: string) => void;
  onNavigateWorkItem?: (factoryId: string, workItemId: string) => void;
}) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(automationCommands.inboxQuery.permissionAtom(environmentId));
  const [kind, setKind] = useState<AutomationInboxQuery["kind"]>();
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filterFactory, setFilterFactory] = useState(factoryId ?? "");
  const [cursor, setCursor] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
  const [items, setItems] = useState<readonly AutomationInboxEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = items.find((item) => item.id === selectedId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reload durable inbox facts after navigation, browser reconnection, focus or an explicit refresh.
  useEffect(() => {
    let disposed = false;
    let latest = generation;
    const load = async () => {
      const sequence = ++latest;
      setBusy(true);
      const input: AutomationInboxQuery = {
        status,
        unreadOnly,
        ...(factoryId || filterFactory ? { factoryId: factoryId || filterFactory } : {}),
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 30,
      };
      const result = await runAtomCommand(
        registry,
        automationCommands.inboxQuery,
        { environmentId, input },
        { reportFailure: false },
      );
      if (disposed || sequence !== latest) return;
      setBusy(false);
      if (AsyncResult.isSuccess(result)) {
        setItems(result.value.items);
        setNextCursor(result.value.nextCursor);
        setMessage("");
      } else setMessage("Inbox could not be loaded. Check your Main connection and refresh.");
    };
    if (canRead) void load();
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
    };
  }, [
    registry,
    environmentId,
    canRead,
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
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Questions, decisions and problems from your factory runs.
          </p>
        </div>
        <Button variant="outline" disabled={busy || !canRead} onClick={refresh}>
          Refresh
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <ListFilters
          factoryId={factoryId ?? filterFactory}
          {...(!factoryId
            ? {
                onFactoryChange: (value: string) => {
                  setFilterFactory(value);
                  setCursor(undefined);
                },
              }
            : {})}
          state={status}
          states={["open", "done", "all"] as const}
          onStateChange={(value) => {
            setStatus(value);
            setCursor(undefined);
          }}
        />
        <label className="space-y-1">
          <span className="text-sm">Type</span>
          <Select
            value={kind ?? "all"}
            onValueChange={(value) => {
              setKind(value === "all" ? undefined : (value as AutomationInboxQuery["kind"]));
              setCursor(undefined);
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
              setUnreadOnly(event.target.checked);
              setCursor(undefined);
            }}
          />
          Unread only
        </label>
      </div>
      {!canRead ? (
        <p role="status" className="text-sm">
          Connect to Main with read permission to open your inbox.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="Inbox items">
            {items.map((item) => (
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
          {canRead && !busy && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching inbox items.</p>
          ) : null}
          <div className="flex gap-2">
            {cursor ? (
              <Button variant="outline" disabled={busy} onClick={() => setCursor(undefined)}>
                First page
              </Button>
            ) : null}
            {nextCursor ? (
              <Button variant="outline" disabled={busy} onClick={() => setCursor(nextCursor)}>
                Next page
              </Button>
            ) : null}
          </div>
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
      {busy || message ? (
        <p role="status" className="text-sm">
          {busy ? "Loading inbox…" : message}
        </p>
      ) : null}
    </section>
  );
}
