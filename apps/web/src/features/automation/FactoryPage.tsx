import { McpBindingsPanel } from "./McpBindingsPanel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { factoryTabs } from "../../foundry/workspaceSearch";
import { AgentCatalog } from "./AgentCatalog";
import { InboxPage } from "./InboxPage";
import { useAtomValue } from "@effect/atom-react";
import type {
  AutomationApplicationCommand,
  AutomationWorkItem,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { TriggerPanel } from "./TriggerPanel";
import { DefinitionSourcePanel } from "./DefinitionSourcePanel";
import { DefinitionEditor } from "./DefinitionEditor";
import { RunDetail } from "./RunDetail";
import { RunList } from "./RunList";
import { WorkItemDetail } from "./WorkItemDetail";

export function FactoryPage({
  environmentId,
  initialView = "factories",
  factoryId: initialFactoryId,
  initialRunId,
  initialWorkItemId,
}: {
  environmentId: EnvironmentId;
  initialView?: "factories" | "runs" | "work";
  factoryId?: string;
  initialRunId?: string;
  initialWorkItemId?: string;
}) {
  const { search, update } = useWorkspaceNavigation();
  const selected = search.factoryId ?? initialFactoryId;
  const runId = search.runId ?? initialRunId;
  const view = search.view ?? initialView;
  const run = selected && runId ? { factoryId: selected, runId } : null;
  function openRun(factoryId: string, runId: string) {
    update({ view: "factories", factoryId, runId, attemptId: undefined, attemptsAfter: undefined });
  }
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-8">
      {run ? (
        <RunDetail
          key={run.runId}
          environmentId={environmentId}
          factoryId={run.factoryId}
          runId={run.runId}
          onBack={() =>
            update({
              runId: undefined,
              attemptId: undefined,
              attemptsAfter: undefined,
              tab: search.workItemId ? "work" : "runs",
            })
          }
        />
      ) : view === "runs" && !selected ? (
        <RunList environmentId={environmentId} onOpen={openRun} />
      ) : selected ? (
        <FactoryDetail
          key={selected}
          environmentId={environmentId}
          factoryId={selected}
          {...(initialWorkItemId ? { initialWorkItemId } : {})}
          onOpenRun={openRun}
        />
      ) : (
        <FactoryList
          environmentId={environmentId}
          workView={view === "work"}
          onOpen={(factoryId) =>
            update({
              view: "factories",
              factoryId,
              tab: view === "work" ? "work" : "overview",
              after: undefined,
              search: undefined,
            })
          }
        />
      )}
    </div>
  );
}
function FactoryList({
  environmentId,
  workView = false,
  onOpen,
}: {
  environmentId: EnvironmentId;
  workView?: boolean;
  onOpen: (id: string) => void;
}) {
  const navigation = useWorkspaceNavigation();
  const after = navigation.search.after;
  const filter = navigation.search.search ?? "";
  const [search, setSearch] = useState<string>();
  const searchValue = search ?? filter;
  const setAfter = (after?: string) => navigation.update({ after });
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "factories",
    limit: 20,
    search: filter,
    ...(after ? { after } : {}),
  });
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const canManage = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "createFactory" }),
  );
  async function create() {
    if (busy) return;
    const input = pending ?? {
      op: "createFactory" as const,
      commandId: randomUUID(),
      id: randomUUID(),
      name,
      scopeVersionId: randomUUID(),
      repositories: repository
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    setPending(input);
    setBusy(true);
    const response = await command({ environmentId, input });
    setBusy(false);
    if (
      AsyncResult.isFailure(response) &&
      isDefinitiveAutomationFailure(squashAtomCommandFailure(response))
    )
      setPending(null);
    if (AsyncResult.isSuccess(response) && response.value.kind === "factory") {
      setPending(null);
      onOpen(response.value.factory.id);
    } else
      setMessage(
        "Factory was not saved. Check permissions and repository scope; unconfirmed requests retain their command ID.",
      );
  }
  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{workView ? "Work" : "Factories"}</h1>
        <p className="text-sm text-muted-foreground">
          {workView
            ? "Choose a factory to see its work items or create a task."
            : "Choose a factory to organize work, guide its agents and review results."}
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigation.update({ search: searchValue, after: undefined });
          setSearch(undefined);
        }}
      >
        <Input
          aria-label="Find factories"
          placeholder="Find a factory…"
          value={searchValue}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button variant="outline" type="submit">
          Search
        </Button>
        <Button variant="outline" type="button" onClick={refresh}>
          Refresh
        </Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">Loading factories…</p> : null}
      {result?.kind === "factories" ? (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {result.items.map((factory) => (
              <li
                key={factory.id}
                className="flex min-w-0 flex-col items-start gap-5 rounded-xl border bg-card p-5"
              >
                <div className="space-y-2">
                  <Badge variant={factory.archived ? "secondary" : "outline"}>
                    {factory.archived ? "Archived" : "Factory"}
                  </Badge>
                  <h2 className="break-words text-lg font-semibold">{factory.name}</h2>
                </div>
                <Button
                  variant="outline"
                  onClick={() => onOpen(factory.id)}
                  aria-label={`Open ${factory.name}`}
                >
                  {workView ? "Open work items →" : "Open workspace →"}
                </Button>
              </li>
            ))}
          </ul>
          {result.items.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <h2 className="font-medium">
                {filter ? "No matching factories" : "Your first factory starts here"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {filter
                  ? "Try another name or clear the search."
                  : "Give your factory a name and choose which repositories it can work on."}
              </p>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
              First page
            </Button>
            <Button
              variant="outline"
              disabled={!result.next}
              onClick={() => setAfter(result.next ?? undefined)}
            >
              Next factories
            </Button>
          </div>
        </>
      ) : null}
      <details
        className="rounded-xl border p-4"
        open={
          result?.kind === "factories" && result.items.length === 0 && !filter ? true : undefined
        }
      >
        <summary className="cursor-pointer font-medium">Create factory</summary>
        <div className="mt-4 space-y-3">
          <fieldset disabled={busy || !canManage || Boolean(pending)} className="space-y-3">
            <legend className="sr-only">Factory details</legend>
            <label className="block space-y-1">
              <span className="text-sm">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">Repository binding keys (comma separated)</span>
              <Input value={repository} onChange={(event) => setRepository(event.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">
              Repository keys define this factory's scope. They do not grant filesystem or Git
              access.
            </p>
          </fieldset>
          <Button
            disabled={busy || !canManage || !name.trim() || !repository.trim()}
            onClick={() => void create()}
          >
            {pending ? "Retry create factory" : "Create factory"}
          </Button>
          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              Your connection does not have permission to create factories.
            </p>
          ) : null}
        </div>
      </details>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
function FactoryDetail({
  environmentId,
  factoryId,
  initialWorkItemId,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  initialWorkItemId?: string;
  onOpenRun: (factoryId: string, runId: string) => void;
}) {
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "factory",
    factoryId,
  });
  const source = useAutomationQuery(environmentId, { op: "definitionSource", factoryId });
  const navigation = useWorkspaceNavigation();
  const workItemId = navigation.search.workItemId ?? initialWorkItemId;
  const tab =
    navigation.search.tab ??
    (workItemId ? "work" : navigation.search.view === "runs" ? "runs" : "overview");
  const setWorkItemId = (workItemId: string) =>
    navigation.update({ workItemId, tab: "work", after: undefined });
  const [title, setTitle] = useState("");
  const [selectedRepository, setRepository] = useState<string>();
  const after = navigation.search.after;
  const setAfter = (after?: string) => navigation.update({ after });
  const works = useAutomationQuery(environmentId, {
    op: "workItems",
    factoryId,
    ...(tab === "overview" ? { activeOnly: true } : {}),
    limit: 20,
    ...(after ? { after } : {}),
  });
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  const detail = result?.kind === "factory" ? result : null;
  const repository =
    selectedRepository ??
    (detail?.active?.definition.repositories.length === 1
      ? detail.active.definition.repositories[0]
      : "");
  async function createWork() {
    if (busy || !detail?.active || !repository) return;
    const input = pending ?? {
      op: "createWorkItem" as const,
      input: {
        commandId: randomUUID(),
        id: randomUUID(),
        factoryId,
        versionId: detail.active.factoryVersionId,
        repository,
        title,
        source: { kind: "manual" as const, reference: randomUUID() },
      },
    };
    setPending(input);
    setBusy(true);
    const response = await command({ environmentId, input });
    setBusy(false);
    if (
      AsyncResult.isFailure(response) &&
      isDefinitiveAutomationFailure(squashAtomCommandFailure(response))
    )
      setPending(null);
    if (AsyncResult.isSuccess(response) && response.value.kind === "workItem") {
      setPending(null);
      setWorkItemId(response.value.item.id);
      works.refresh();
    } else
      setMessage("Work item could not be saved. Unconfirmed requests retain their command ID.");
  }
  return (
    <section className="space-y-6">
      {loading ? <p role="status">Loading factory…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="space-y-4">
        <Link
          to="/foundry"
          search={{ view: "factories" }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All factories
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="break-words text-2xl font-semibold tracking-tight">
              {detail?.factory.name ?? "Factory workspace"}
            </h1>
            <p className="break-words text-sm text-muted-foreground">
              {detail?.active?.definition.repositories.join(" · ") ??
                "Configure a definition to begin work."}
            </p>
            {detail ? (
              <Badge
                variant={
                  detail.factory.archived ? "secondary" : detail.active ? "success" : "warning"
                }
              >
                {detail.factory.archived
                  ? "Archived"
                  : detail.active
                    ? "Active definition"
                    : "Setup needed"}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                refresh();
                works.refresh();
              }}
            >
              Refresh
            </Button>
            <Button
              disabled={!detail?.active || !allowed}
              onClick={() =>
                navigation.update({ tab: "work", workItemId: undefined, after: undefined })
              }
            >
              New work item
            </Button>
          </div>
        </div>
      </div>
      <nav aria-label="Selected factory" className="flex flex-wrap gap-1 border-b pb-3">
        {factoryTabs.map((value) => (
          <Button
            key={value}
            variant={tab === value ? "secondary" : "ghost"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              navigation.update({
                tab: value,
                workItemId: undefined,
                after: undefined,
                runState: undefined,
              });
            }}
          >
            {value === "work"
              ? "Work items"
              : value === "agents"
                ? "Agents & skills"
                : value.charAt(0).toUpperCase() + value.slice(1)}
          </Button>
        ))}
        <Link
          className="self-center px-3 text-sm underline"
          to="/foundry"
          search={{ view: "inbox", factoryId }}
        >
          Inbox
        </Link>
      </nav>
      {tab === "overview" ? (
        <div className="space-y-6">
          {!detail?.active && detail ? (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5">
              <div>
                <h2 className="font-semibold">Prepare this factory</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Import or create a definition, then activate it to make workflows available.
                </p>
              </div>
              <Button onClick={() => navigation.update({ tab: "definition" })}>
                Set up definition
              </Button>
            </section>
          ) : null}
          <InboxPage
            environmentId={environmentId}
            factoryId={factoryId}
            compact
            onNavigateRun={onOpenRun}
            onNavigateWorkItem={(_, id) => setWorkItemId(id)}
          />
          <section className="space-y-3" aria-label="Open work">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">Open work</h2>
                <p className="text-sm text-muted-foreground">
                  Outcomes to deliver, across their workflow runs.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  navigation.update({ tab: "work", workItemId: undefined, after: undefined })
                }
              >
                All work items
              </Button>
            </div>
            {works.error ? <p role="alert">{works.error}</p> : null}
            {works.loading ? <p role="status">Loading open work…</p> : null}
            {works.result?.kind === "workItems" ? (
              <WorkItems
                items={works.result.items}
                onOpen={setWorkItemId}
                emptyMessage="No open work. Create an item to give this factory its next task."
              />
            ) : null}
            {works.result?.kind === "workItems" && works.result.next ? (
              <p className="text-xs text-muted-foreground">
                More open work is available under Work items.
              </p>
            ) : null}
          </section>
          <RunList environmentId={environmentId} factoryId={factoryId} onOpen={onOpenRun} compact />
        </div>
      ) : null}
      {tab === "agents" ? (
        <>
          <AgentCatalog active={detail?.active ?? null} />
          {detail?.active?.definition.schemaVersion === 4 ? (
            <McpBindingsPanel
              environmentId={environmentId}
              factoryId={factoryId}
              resources={detail.active.definition.mcp}
            />
          ) : null}
        </>
      ) : null}
      {tab === "definition" && detail ? (
        <div className="space-y-5">
          {source.error ? <p role="alert">{source.error}</p> : null}
          {source.loading ? <p role="status">Loading definition ownership…</p> : null}
          <Button
            variant="outline"
            onClick={() => {
              source.refresh();
              refresh();
            }}
          >
            Reload definition
          </Button>
          {source.result?.kind === "definitionSource" && !source.error ? (
            <>
              <DefinitionSourcePanel
                environmentId={environmentId}
                factoryId={factoryId}
                scopeVersionId={detail.active?.scopeVersionId ?? detail.versions[0]?.id ?? ""}
                active={detail.active}
                binding={source.result.binding}
                onChanged={() => {
                  source.refresh();
                  refresh();
                }}
              />
              {source.result.binding?.ownership !== "git" && !source.loading ? (
                <DefinitionEditor
                  key={detail.active?.id ?? "new"}
                  environmentId={environmentId}
                  factoryId={factoryId}
                  scopeVersionId={detail.active?.scopeVersionId ?? detail.versions[0]?.id ?? ""}
                  repositories={
                    detail.active?.definition.repositories ?? detail.versions[0]?.repositories ?? []
                  }
                  active={detail.active}
                  onActivated={() => {
                    refresh();
                    source.refresh();
                  }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {tab === "triggers" ? (
        <TriggerPanel
          environmentId={environmentId}
          factoryId={factoryId}
          active={detail?.active ?? null}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {tab === "runs" ? (
        <RunList environmentId={environmentId} factoryId={factoryId} onOpen={onOpenRun} />
      ) : null}
      {tab === "work" ? (
        workItemId ? (
          <WorkItemDetail
            key={workItemId}
            environmentId={environmentId}
            factoryId={factoryId}
            workItemId={workItemId}
            active={detail?.active ?? null}
            onOpenRun={onOpenRun}
          />
        ) : (
          <div className="space-y-3">
            <fieldset
              disabled={busy || !allowed || !detail?.active || Boolean(pending)}
              className="space-y-3 rounded-xl border bg-card p-4"
            >
              <legend className="px-1">New work item</legend>
              <label className="block space-y-1">
                <span className="text-sm">What should this factory do?</span>
                <Input
                  value={title}
                  maxLength={500}
                  placeholder="Describe the intended change and result"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <p className="text-sm">Choose repository</p>
              <div className="flex flex-wrap gap-2">
                {detail?.active?.definition.repositories.map((key) => (
                  <Button
                    key={key}
                    variant={repository === key ? "default" : "outline"}
                    onClick={() => setRepository(key)}
                  >
                    {key}
                  </Button>
                ))}
              </div>
              {!detail?.active ? (
                <p className="text-sm">Activate a definition before creating work.</p>
              ) : null}
            </fieldset>
            <Button
              disabled={busy || !allowed || !repository || !title.trim()}
              onClick={() => void createWork()}
            >
              {pending ? "Retry create work item" : "Create work item"}
            </Button>
            {!allowed ? (
              <p className="text-sm text-muted-foreground">
                Your connection can view work but cannot create it.
              </p>
            ) : null}
            {message ? <p role="status">{message}</p> : null}
            <h2 className="pt-4 text-lg font-semibold">Work items</h2>
            {works.loading ? <p role="status">Loading work…</p> : null}
            {works.error ? <p role="alert">{works.error}</p> : null}
            {works.result?.kind === "workItems" ? (
              <>
                <WorkItems
                  items={works.result.items}
                  onOpen={setWorkItemId}
                  emptyMessage="No work items on this page."
                />
                <div className="flex gap-2">
                  <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
                    First page
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!works.result.next}
                    onClick={() =>
                      setAfter(
                        works.result?.kind === "workItems"
                          ? (works.result.next ?? undefined)
                          : undefined,
                      )
                    }
                  >
                    Next work items
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

function WorkItems({
  items,
  onOpen,
  emptyMessage,
}: {
  items: readonly AutomationWorkItem[];
  onOpen: (id: string) => void;
  emptyMessage: string;
}) {
  if (items.length === 0)
    return (
      <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="break-words font-medium">{item.title}</h3>
            <p className="break-words text-xs text-muted-foreground">{item.repository}</p>
          </div>
          <Badge
            variant={
              item.state === "review"
                ? "warning"
                : item.state === "in_progress"
                  ? "info"
                  : item.state === "completed"
                    ? "success"
                    : "secondary"
            }
          >
            {item.state.replaceAll("_", " ")}
          </Badge>
          <Button
            variant="ghost"
            onClick={() => onOpen(item.id)}
            aria-label={`Open work item: ${item.title}`}
          >
            Open →
          </Button>
        </li>
      ))}
    </ul>
  );
}
