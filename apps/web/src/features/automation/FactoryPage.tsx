import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { AutomationApplicationCommand, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
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
  const [selected, setSelected] = useState<string | null>(initialFactoryId ?? null);
  const [run, setRun] = useState<{ factoryId: string; runId: string } | null>(
    initialFactoryId && initialRunId ? { factoryId: initialFactoryId, runId: initialRunId } : null,
  );
  const [view, setView] = useState(initialView);
  function openRun(factoryId: string, runId: string) {
    setRun({ factoryId, runId });
  }
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-5">
      <nav aria-label="Factory navigation" className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setView("factories");
            setSelected(null);
            setRun(null);
          }}
        >
          Factories
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setView("runs");
            setRun(null);
          }}
        >
          All runs
        </Button>
        {selected ? (
          <Button
            variant="ghost"
            onClick={() => {
              setView("factories");
              setRun(null);
            }}
          >
            {selected}
          </Button>
        ) : null}
      </nav>
      {run ? (
        <RunDetail
          key={run.runId}
          environmentId={environmentId}
          factoryId={run.factoryId}
          runId={run.runId}
          onBack={() => setRun(null)}
        />
      ) : view === "runs" ? (
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
        <FactoryList environmentId={environmentId} onOpen={setSelected} />
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
  const [after, setAfter] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
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
        "Factory was not saved. Check permissions and repository scope; retry uses the same command.",
      );
  }
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Factories</h1>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAfter(undefined);
          setFilter(search);
        }}
      >
        <Input
          aria-label="Find factories"
          value={search}
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
  const [tab, setTab] = useState<"definition" | "work" | "runs">(
    initialWorkItemId ? "work" : "definition",
  );
  const [workItemId, setWorkItemId] = useState<string | null>(initialWorkItemId ?? null);
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState("");
  const [after, setAfter] = useState<string>();
  const works = useAutomationQuery(environmentId, {
    op: "workItems",
    factoryId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  const detail = result?.kind === "factory" ? result : null;
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
    } else setMessage("Work item could not be saved. Retry uses the same command.");
  }
  return (
    <section className="space-y-4">
      {error ? <p role="alert">{error}</p> : null}
      <h1 className="text-xl font-semibold">{detail?.factory.name ?? factoryId}</h1>
      <nav aria-label="Selected factory" className="flex gap-2">
        {(["definition", "work", "runs"] as const).map((value) => (
          <Button
            key={value}
            variant={tab === value ? "default" : "outline"}
            onClick={() => {
              setTab(value);
              setWorkItemId(null);
            }}
          >
            {value === "work" ? "Work items" : value.charAt(0).toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </nav>
      {tab === "definition" && detail ? (
        <DefinitionEditor
          key={detail.active?.id ?? "new"}
          environmentId={environmentId}
          factoryId={factoryId}
          scopeVersionId={detail.active?.scopeVersionId ?? detail.versions[0]?.id ?? ""}
          repositories={
            detail.active?.definition.repositories ?? detail.versions[0]?.repositories ?? []
          }
          active={detail.active}
          onActivated={refresh}
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
                <span className="text-sm">Title</span>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
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
