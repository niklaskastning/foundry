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
import type { AutomationApplicationCommand, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
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
  initialView?: "factories" | "runs";
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
    <div className="mx-auto w-full max-w-5xl space-y-5 p-5">
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
          onOpen={(factoryId) =>
            update({
              view: "factories",
              factoryId,
              tab: "overview",
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
  onOpen,
}: {
  environmentId: EnvironmentId;
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
  const { result, error, refresh } = useAutomationQuery(environmentId, {
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
      <h1 className="text-xl font-semibold">Factories</h1>
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
          value={searchValue}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button variant="outline" type="submit">
          Search
        </Button>
        <Button variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {result?.kind === "factories" ? (
        <>
          <ul className="divide-y rounded-lg border">
            {result.items.map((factory) => (
              <li key={factory.id} className="flex items-center justify-between gap-2 p-3">
                <span className="text-sm">
                  {factory.name}
                  {factory.archived ? " · Archived" : ""}
                </span>
                <Button variant="ghost" onClick={() => onOpen(factory.id)}>
                  Open factory
                </Button>
              </li>
            ))}
          </ul>
          {result.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No factories yet. Create one with an explicit repository scope.
            </p>
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
      <fieldset disabled={busy || Boolean(pending)} className="space-y-3 rounded-lg border p-3">
        <legend className="px-1">Create factory</legend>
        <label className="block space-y-1">
          <span className="text-sm">Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Repository binding keys (comma separated)</span>
          <Input value={repository} onChange={(event) => setRepository(event.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">
          Repository keys define this factory's scope. They do not grant filesystem or Git access.
        </p>
      </fieldset>
      <Button
        disabled={busy || !canManage || !name.trim() || !repository.trim()}
        onClick={() => void create()}
      >
        {pending ? "Retry create factory" : "Create factory"}
      </Button>
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
  const { result, error, refresh } = useAutomationQuery(environmentId, {
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
    <section className="space-y-4">
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <Link
          to="/foundry"
          search={{ view: "factories" }}
          className="text-sm text-muted-foreground underline"
        >
          All factories
        </Link>
        <h1 className="text-xl font-semibold">{detail?.factory.name ?? "Loading factory…"}</h1>
        <p className="text-sm text-muted-foreground">
          Factory workspace ·{" "}
          {detail?.active?.definition.repositories.join(", ") ?? "No active definition"}
        </p>
      </div>
      <nav aria-label="Selected factory" className="flex flex-wrap gap-2">
        {factoryTabs.map((value) => (
          <Button
            key={value}
            variant={tab === value ? "default" : "outline"}
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
          <section className="space-y-3" aria-label="Open work">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-medium">Open work</h2>
              <Button onClick={() => navigation.update({ tab: "work", workItemId: undefined })}>
                New work item
              </Button>
            </div>
            {works.error ? <p role="alert">{works.error}</p> : null}
            {works.result?.kind === "workItems" ? (
              <ul className="divide-y rounded-lg border">
                {works.result.items
                  .filter((item) => item.state !== "completed" && item.state !== "cancelled")
                  .map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2 p-3">
                      <span className="text-sm">
                        {item.title} · {item.state.replaceAll("_", " ")}
                      </span>
                      <Button variant="ghost" onClick={() => setWorkItemId(item.id)}>
                        Open work item
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Open items on the current page. All work and pagination are available under Work
              items.
            </p>
          </section>
          <InboxPage
            environmentId={environmentId}
            factoryId={factoryId}
            compact
            onNavigateRun={onOpenRun}
            onNavigateWorkItem={(_, id) => setWorkItemId(id)}
          />
          <RunList environmentId={environmentId} factoryId={factoryId} onOpen={onOpenRun} compact />
        </div>
      ) : null}
      {tab === "agents" ? <AgentCatalog active={detail?.active ?? null} /> : null}
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
            {works.error ? <p role="alert">{works.error}</p> : null}
            {works.result?.kind === "workItems" ? (
              <>
                <ul className="divide-y rounded border">
                  {works.result.items.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2 p-3">
                      <span className="text-sm">
                        {item.title} · {item.state}
                      </span>
                      <Button variant="ghost" onClick={() => setWorkItemId(item.id)}>
                        Open work item
                      </Button>
                    </li>
                  ))}
                </ul>
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
            <fieldset disabled={busy || Boolean(pending)} className="space-y-3 rounded border p-3">
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
            {message ? <p role="status">{message}</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}
