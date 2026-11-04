import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  AutomationTriggerCommand,
  type AutomationTriggerBinding,
  type EnvironmentId,
  type FactoryDefinitionVersion,
} from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { useTriggerQuery } from "./useTriggerQuery";

const decodeCommand = Schema.decodeUnknownSync(AutomationTriggerCommand, {
  onExcessProperty: "error",
});

export function TriggerPanel({
  environmentId,
  factoryId,
  active,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  active: FactoryDefinitionVersion | null;
  onOpenRun: (factoryId: string, runId: string) => void;
}) {
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<AutomationTriggerBinding | null>(null);
  const query = useTriggerQuery(environmentId, {
    op: "bindings",
    factoryId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<AutomationTriggerCommand | null>(null);
  const command = useAtomCommand(automationCommands.triggerCommand, { reportFailure: false });
  const allowed = useAtomValue(automationCommands.triggerCommand.permissionAtom(environmentId));
  async function send(input: AutomationTriggerCommand) {
    setBusy(true);
    const response = await command({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(response)) {
      setPending(null);
      setMessage("Trigger decision saved.");
      query.refresh();
      if (response.value.kind === "binding") setSelected(response.value.binding);
    } else {
      if (isDefinitiveAutomationFailure(squashAtomCommandFailure(response))) {
        setPending(null);
        query.refresh();
      }
      setMessage(
        "Decision not confirmed. Refresh to check permissions and the current trigger generation; unconfirmed requests keep their command ID.",
      );
    }
  }
  async function execute(input: AutomationTriggerCommand) {
    if (busy || pending) return;
    setPending(input);
    await send(input);
  }
  const items = query.result?.kind === "bindings" ? query.result.items : [];
  return (
    <section className="space-y-4" aria-label="Workflow triggers">
      <h2 className="text-lg font-medium">Workflow triggers</h2>
      <p className="text-sm text-muted-foreground">
        Triggers keep their activated workflow version. Create an inactive trigger, review its
        destination, then explicitly authorize unattended execution. Decisions and questions remain
        in Inbox.
      </p>
      <Button variant="outline" onClick={query.refresh}>
        Refresh triggers
      </Button>
      {query.error ? <p role="alert">{query.error}</p> : null}
      <ul className="divide-y rounded border">
        {items.map((binding) => (
          <li key={binding.id} className="space-y-2 p-3">
            <p className="text-sm">
              {binding.source.kind === "github_issue"
                ? `${binding.source.repository} · ${binding.source.label}`
                : `${binding.source.config.timeOfDay} · ${binding.source.config.timeZone}`}{" "}
              · {binding.state}
            </p>
            <p className="text-xs text-muted-foreground">
              Workflow {binding.workflowVersionId} · Project {binding.target.projectId}
              {binding.reason ? ` · ${binding.reason}` : ""}
              {binding.nextDueAt !== null
                ? ` · Next ${new Date(binding.nextDueAt).toISOString()}`
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setSelected(binding)}>
                View inputs
              </Button>
              <Button
                disabled={
                  !allowed ||
                  busy ||
                  Boolean(pending) ||
                  !["inactive", "paused"].includes(binding.state)
                }
                onClick={() =>
                  void execute({
                    op: "activate",
                    commandId: randomUUID(),
                    bindingId: binding.id,
                    generation: binding.generation,
                  })
                }
              >
                Authorize and activate
              </Button>
              <Button
                variant="outline"
                disabled={
                  !allowed ||
                  busy ||
                  Boolean(pending) ||
                  !["active", "baselining"].includes(binding.state)
                }
                onClick={() =>
                  void execute({
                    op: "deactivate",
                    commandId: randomUUID(),
                    bindingId: binding.id,
                    generation: binding.generation,
                    pending: "retain",
                  })
                }
              >
                Pause, retain inputs
              </Button>
              <Button
                variant="outline"
                disabled={
                  !allowed ||
                  busy ||
                  Boolean(pending) ||
                  !["active", "baselining"].includes(binding.state)
                }
                onClick={() =>
                  void execute({
                    op: "deactivate",
                    commandId: randomUUID(),
                    bindingId: binding.id,
                    generation: binding.generation,
                    pending: "discard",
                  })
                }
              >
                Pause, discard pending
              </Button>
              <Button
                variant="destructive"
                disabled={!allowed || busy || Boolean(pending) || binding.state === "revoked"}
                onClick={() =>
                  void execute({
                    op: "revoke",
                    commandId: randomUUID(),
                    bindingId: binding.id,
                    generation: binding.generation,
                  })
                }
              >
                Revoke authorization
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <p className="text-sm">No triggers configured.</p> : null}
      <div className="flex gap-2">
        <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
          First triggers
        </Button>
        <Button
          variant="outline"
          disabled={query.result?.kind !== "bindings" || !query.result.next}
          onClick={() =>
            setAfter(
              query.result?.kind === "bindings" ? (query.result.next ?? undefined) : undefined,
            )
          }
        >
          Next triggers
        </Button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {pending ? (
        <Button disabled={busy || !allowed} onClick={() => void send(pending)}>
          Retry unconfirmed decision
        </Button>
      ) : null}
      {selected ? (
        <TriggerInputs
          key={selected.id}
          environmentId={environmentId}
          binding={selected}
          onOpenRun={onOpenRun}
        />
      ) : null}
      <CreateTrigger
        environmentId={environmentId}
        factoryId={factoryId}
        active={active}
        disabled={!allowed || busy || Boolean(pending)}
        onCreate={execute}
      />
    </section>
  );
}

function TriggerInputs({
  environmentId,
  binding,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  binding: AutomationTriggerBinding;
  onOpenRun: (factoryId: string, runId: string) => void;
}) {
  const [after, setAfter] = useState<string>();
  const query = useTriggerQuery(environmentId, {
    op: "events",
    bindingId: binding.id,
    limit: 20,
    ...(after ? { after } : {}),
  });
  return (
    <section className="space-y-2 rounded border p-3" aria-label="Durable workflow inputs">
      <h3 className="font-medium">Durable inputs · {binding.id}</h3>
      <p className="text-xs text-muted-foreground">
        Technical input history is separate from your personal Inbox. Baseline issues never start a
        run.
      </p>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.result?.kind === "events" ? (
        <>
          <ul className="divide-y">
            {query.result.items.map((event) => (
              <li key={event.id} className="space-y-1 py-2 text-sm">
                <p>
                  {event.title} · {event.state}
                  {event.reason ? ` · ${event.reason}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {event.source} · {event.externalId} · {new Date(event.occurredAt).toISOString()} ·
                  Revision {event.revision}
                </p>
                {event.runId ? (
                  <Button
                    variant="outline"
                    onClick={() => onOpenRun(binding.factoryId, event.runId!)}
                  >
                    Open admitted run
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
              First inputs
            </Button>
            <Button
              variant="outline"
              disabled={!query.result.next}
              onClick={() =>
                setAfter(
                  query.result?.kind === "events" ? (query.result.next ?? undefined) : undefined,
                )
              }
            >
              Next inputs
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function CreateTrigger({
  environmentId,
  factoryId,
  active,
  disabled,
  onCreate,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  active: FactoryDefinitionVersion | null;
  disabled: boolean;
  onCreate: (input: AutomationTriggerCommand) => Promise<void>;
}) {
  const worker = useAutomationQuery(environmentId, { op: "workerBinding" });
  const target = worker.result?.kind === "workerBinding" ? worker.result : null;
  const [workflow, setWorkflow] = useState("");
  const [repository, setRepository] = useState("");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [checks, setChecks] = useState("[]");
  const [artifacts, setArtifacts] = useState("[]");
  const [kind, setKind] = useState<"github_issue" | "schedule">("schedule");
  const [connection, setConnection] = useState("");
  const [githubRepository, setGithubRepository] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [label, setLabel] = useState("");
  const [time, setTime] = useState("09:00");
  const [zone, setZone] = useState("UTC");
  const [weekdays, setWeekdays] = useState("1,2,3,4,5");
  const [catchUp, setCatchUp] = useState<"skip" | "latest" | "bounded">("skip");
  const [maximum, setMaximum] = useState("1");
  const [overlap, setOverlap] = useState<"wait" | "skip">("wait");
  const [error, setError] = useState("");
  async function create() {
    if (!active || !target) return;
    try {
      const input = decodeCommand({
        op: "create",
        commandId: randomUUID(),
        id: randomUUID(),
        factoryId,
        definitionVersionId: active.id,
        workflowVersionId: workflow,
        repository,
        target: {
          deviceId: target.deviceId,
          environmentId: target.environmentId,
          projectId: project,
          model,
          checks: JSON.parse(checks),
          requiredArtifacts: JSON.parse(artifacts),
        },
        source:
          kind === "github_issue"
            ? {
                kind,
                connectionId: connection,
                repositoryId: Number(repositoryId),
                repository: githubRepository,
                label,
              }
            : {
                kind,
                config: {
                  timeZone: zone,
                  timeOfDay: time,
                  weekdays: weekdays.split(",").map(Number),
                  catchUp,
                  maxCatchUp: Number(maximum),
                  overlap,
                },
              },
      });
      setError("");
      await onCreate(input);
    } catch {
      setError("Check the workflow, project, source and check bindings before saving.");
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <fieldset disabled={disabled || !active} className="space-y-3 rounded border p-3">
        <legend>Create inactive trigger</legend>
        {!active ? <p>Activate a definition first.</p> : null}
        <p className="text-xs text-muted-foreground">
          Activation grants unattended execution on this exact worker project. Existing opted-in
          GitHub issues are recorded as baseline. Schedules start after activation; no historical
          backlog is imported.
        </p>
        <div className="flex flex-wrap gap-2">
          {active?.workflowVersions.map((item) => (
            <Button
              key={item.versionId}
              type="button"
              variant={workflow === item.versionId ? "default" : "outline"}
              onClick={() => setWorkflow(item.versionId)}
            >
              {item.id}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {active?.definition.repositories.map((item) => (
            <Button
              key={item}
              type="button"
              variant={repository === item ? "default" : "outline"}
              onClick={() => setRepository(item)}
            >
              {item}
            </Button>
          ))}
        </div>
        <p className="text-sm">Worker: {target?.environmentId ?? "Unavailable"}</p>
        <div className="flex flex-wrap gap-2">
          {target?.projects.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={project === item.id ? "default" : "outline"}
              onClick={() => setProject(item.id)}
            >
              {item.title}
            </Button>
          ))}
        </div>
        <label className="block space-y-1">
          <span>Model</span>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span>Checks (id, prompt, command, cwd)</span>
          <Textarea value={checks} onChange={(e) => setChecks(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span>Required artifacts (stepId, names)</span>
          <Textarea value={artifacts} onChange={(e) => setArtifacts(e.target.value)} />
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={kind === "schedule" ? "default" : "outline"}
            onClick={() => setKind("schedule")}
          >
            Schedule
          </Button>
          <Button
            type="button"
            variant={kind === "github_issue" ? "default" : "outline"}
            onClick={() => setKind("github_issue")}
          >
            GitHub issue
          </Button>
        </div>
        {kind === "github_issue" ? (
          <>
            <label className="block space-y-1">
              <span>GitHub App connection</span>
              <Input value={connection} onChange={(e) => setConnection(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>GitHub repository (owner/name)</span>
              <Input
                value={githubRepository}
                onChange={(e) => setGithubRepository(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span>Repository ID</span>
              <Input value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>Opt-in label</span>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span>Local time (HH:mm)</span>
              <Input value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>IANA time zone</span>
              <Input value={zone} onChange={(e) => setZone(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>Weekdays (0 Sunday through 6 Saturday)</span>
              <Input value={weekdays} onChange={(e) => setWeekdays(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              {(["skip", "latest", "bounded"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={catchUp === value ? "default" : "outline"}
                  onClick={() => setCatchUp(value)}
                >
                  Missed: {value}
                </Button>
              ))}
            </div>
            {catchUp === "bounded" ? (
              <label className="block space-y-1">
                <span>Maximum missed occurrences (1–10)</span>
                <Input value={maximum} onChange={(e) => setMaximum(e.target.value)} />
              </label>
            ) : null}
            <div className="flex gap-2">
              {(["wait", "skip"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={overlap === value ? "default" : "outline"}
                  onClick={() => setOverlap(value)}
                >
                  Overlap: {value}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Missing spring clock times are skipped; repeated autumn times run once, at the first
              occurrence. Missed schedules use the selected bounded catch-up policy.
            </p>
          </>
        )}
        <Button
          type="submit"
          disabled={!target || !workflow || !repository || !project || !model.trim()}
        >
          Save inactive trigger
        </Button>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
