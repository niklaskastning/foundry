import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure, startFailureMessage } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useSandboxProfiles } from "../../foundry/useSandboxProfiles";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "../../components/ui/badge";
import { useAtomValue } from "@effect/atom-react";
import {
  ProjectId,
  ManualStart,
  type AutomationApplicationCommand,
  type AutomationWorkItem,
  type EnvironmentId,
  type FactoryDefinitionVersion,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { resolveFactoryWorkflow } from "@t3tools/shared/factoryDefinition";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { HandoffList } from "./HandoffPanel";
import { RunList } from "./RunList";
import { WorkerPoolPicker } from "./WorkerPoolPicker";
import { WorkflowConfiguration } from "./AgentCatalog";

const decodeManualStart = Schema.decodeUnknownSync(ManualStart, { onExcessProperty: "error" });

export function WorkItemDetail({
  environmentId,
  factoryId,
  workItemId,
  active,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  workItemId: string;
  active: FactoryDefinitionVersion | null;
  onOpenRun: (factoryId: string, runId: string) => void;
}) {
  const work = useAutomationQuery(environmentId, { op: "workItem", factoryId, workItemId });
  return (
    <section className="space-y-4" aria-label="Work item detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/foundry"
          search={(previous) => ({
            ...previous,
            view: "factories",
            factoryId,
            tab: "work",
            workItemId: undefined,
          })}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Work items
        </Link>
        <Button variant="outline" onClick={work.refresh}>
          Refresh work item
        </Button>
      </div>
      {work.loading && !work.result ? <p role="status">Loading work item…</p> : null}
      {work.error ? <p role="alert">{work.error}</p> : null}
      {work.result?.kind === "workItem" ? (
        <>
          <div className="space-y-3 border-b pb-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="min-w-0 flex-1 break-words text-xl font-semibold">
                {work.result.item.title}
              </h2>
              <Badge
                variant={
                  work.result.item.state === "review"
                    ? "warning"
                    : work.result.item.state === "completed"
                      ? "success"
                      : work.result.item.state === "in_progress"
                        ? "info"
                        : "secondary"
                }
              >
                {work.result.item.state.replaceAll("_", " ")}
              </Badge>
            </div>
            <p className="break-words text-sm text-muted-foreground">
              {work.result.item.repository}
            </p>
            <p className="text-sm">
              {work.result.item.state === "open"
                ? "Choose a workflow to begin, or review an earlier run. Completing a run does not close this work item."
                : work.result.item.state === "in_progress"
                  ? "Work is in progress. Open its run to follow execution or take action."
                  : work.result.item.state === "review"
                    ? "Review the run results and resolve any outstanding decisions."
                    : work.result.item.state === "completed"
                      ? "This work item is complete. Its runs and results remain available below."
                      : "This work item was cancelled. Its execution history remains available below."}
            </p>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Work item reference
              </summary>
              <dl className="mt-2 space-y-1 break-all text-xs text-muted-foreground">
                <div>
                  <dt>Source</dt>
                  <dd>
                    {work.result.item.source.kind} · {work.result.item.source.reference}
                  </dd>
                </div>
                <div>
                  <dt>Work item</dt>
                  <dd>{work.result.item.id}</dd>
                </div>
              </dl>
            </details>
          </div>
          <h3 className="text-lg font-semibold">Execution & results</h3>
          <p className="text-sm text-muted-foreground">
            Open a run for its changes, pull request, decisions and execution history.
          </p>
          <RunList
            environmentId={environmentId}
            factoryId={factoryId}
            workItemId={workItemId}
            onOpen={onOpenRun}
          />
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer font-medium">Start new workflow</summary>
            <div className="pt-4">
              <StartWorkflow
                key={work.result.item.id}
                environmentId={environmentId}
                item={work.result.item}
                active={active}
                onOpenRun={onOpenRun}
              />
            </div>
          </details>
        </>
      ) : null}
      <HandoffList environmentId={environmentId} factoryId={factoryId} workItemId={workItemId} />
    </section>
  );
}

function StartWorkflow({
  environmentId,
  item,
  active,
  onOpenRun,
}: {
  environmentId: EnvironmentId;
  item: AutomationWorkItem;
  active: FactoryDefinitionVersion | null;
  onOpenRun: (factoryId: string, runId: string) => void;
}) {
  const binding = useAutomationQuery(environmentId, { op: "workerBinding" });
  const defaultsQuery = useAutomationQuery(environmentId, {
    op: "executionDefaults",
    factoryId: item.factoryId,
    repository: item.repository,
  });
  const defaults =
    defaultsQuery.result?.kind === "executionDefaults" ? defaultsQuery.result.defaults : null;
  const target = binding.result?.kind === "workerBinding" ? binding.result : null;
  const sandboxCatalog = useSandboxProfiles(environmentId);
  const [sandboxOverride, setSandboxKey] = useState<string>();
  const sandboxKey =
    sandboxOverride ??
    (defaults?.sandbox ? `${defaults.sandbox.profileId}:${defaults.sandbox.revision}` : "worker");
  const sandbox =
    active?.definition.schemaVersion === 4
      ? sandboxCatalog?.profiles.find(
          (profile) => `${profile.profileId}:${profile.revision}` === sandboxKey,
        )
      : undefined;
  const [selectedWorkflow, setWorkflowVersionId] = useState<string>();
  const workflowVersionId =
    active?.workflowVersions.find((workflow) => workflow.versionId === selectedWorkflow)
      ?.versionId ??
    active?.workflowVersions[0]?.versionId ??
    "";
  const workflow = active?.workflowVersions.find(
    (workflow) => workflow.versionId === workflowVersionId,
  );
  const [workersOverride, setWorkers] = useState<ManualStart["workers"] | null>();
  const execution =
    active?.definition.schemaVersion !== 4
      ? active?.definition.workflows.find((entry) => entry.id === workflow?.id)?.execution
      : undefined;
  const v4 = active?.definition.schemaVersion === 4;
  const parallel = v4 || execution?.mode === "parallel";
  const workers = parallel
    ? workersOverride === undefined
      ? defaults?.workers
      : (workersOverride ?? undefined)
    : undefined;
  const [projectOverride, setProjectId] = useState<string>();
  const [modelOverride, setModel] = useState<string>();
  const [revisionOverride, setRevision] = useState<string>();
  const revision = revisionOverride ?? (parallel ? "" : `work-item:${item.id}`);
  const [workflowInputs, setWorkflowInputs] = useState("{}");
  const [checksOverride, setChecks] = useState<string>();
  const [artifactsOverride, setArtifacts] = useState<string>();
  const projectId = projectOverride ?? defaults?.projectId ?? "";
  const firstAgent =
    active && workflow
      ? resolveFactoryWorkflow(active.definition, workflow.id).find(
          (step) => step.kind === "agent" && step.resolved?.execution.model,
        )
      : undefined;
  const model =
    modelOverride ??
    defaults?.model ??
    (active?.definition.schemaVersion === 4
      ? active.definition.defaults?.execution.model
      : active?.definition.defaults?.model) ??
    (firstAgent?.kind === "agent" ? firstAgent.resolved?.execution.model : undefined) ??
    "";
  const checks = checksOverride ?? JSON.stringify(defaults?.checks ?? [], null, 2);
  const artifacts = artifactsOverride ?? JSON.stringify(defaults?.requiredArtifacts ?? [], null, 2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const canStart = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  const canConfigure = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "configureExecutionDefaults" }),
  );
  const selectedProject = target?.projects.find((project) => project.id === projectId);
  const configured = Boolean(
    (workers?.length || selectedProject) && model && (sandboxKey === "worker" || sandbox),
  );
  async function submit(action: "start" | "save") {
    if (
      busy ||
      (!pending &&
        (!configured || defaultsQuery.loading || defaultsQuery.error || !workflowVersionId))
    )
      return;
    let input: AutomationApplicationCommand;
    try {
      if (pending) {
        input = pending;
      } else {
        const start = decodeManualStart({
          commandId: randomUUID(),
          id: randomUUID(),
          factoryId: item.factoryId,
          workItemId: item.id,
          workflowVersionId,
          revision: sandbox?.checkout.commit ?? revision,
          ...(sandbox
            ? { sandbox: { profileId: sandbox.profileId, revision: sandbox.revision } }
            : {}),
          ...(v4 ? { inputs: JSON.parse(workflowInputs) } : {}),
          projectId: workers?.[0]?.projectId ?? ProjectId.make(projectId),
          ...(!sandbox && workers ? { workers } : {}),
          model,
          checks: JSON.parse(checks),
          requiredArtifacts: JSON.parse(artifacts),
        });
        input =
          action === "start"
            ? { op: "start", input: start }
            : {
                op: "configureExecutionDefaults",
                commandId: randomUUID(),
                factoryId: item.factoryId,
                repository: item.repository,
                expectedGeneration: defaults?.generation ?? null,
                projectId: start.projectId,
                ...(start.workers ? { workers: start.workers } : {}),
                ...(start.sandbox ? { sandbox: start.sandbox } : {}),
                model: start.model,
                checks: start.checks,
                requiredArtifacts: start.requiredArtifacts,
              };
      }
    } catch {
      setMessage(
        "Check the binding fields. Checks require id, prompt, command and cwd; artifacts require stepId and names.",
      );
      return;
    }
    setPending(input);
    setBusy(true);
    const result = await command({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setPending(null);
      if (result.value.kind === "run") onOpenRun(item.factoryId, result.value.run.id);
      else {
        setMessage(
          "Execution defaults saved for this factory and repository. Starting each run still requires authorization.",
        );
        defaultsQuery.refresh();
      }
    } else {
      const failure = squashAtomCommandFailure(result);
      if (isDefinitiveAutomationFailure(failure)) {
        setPending(null);
        defaultsQuery.refresh();
        binding.refresh();
      }
      setMessage(startFailureMessage(failure));
    }
  }
  return (
    <section className="space-y-3" aria-label="Start workflow">
      <fieldset disabled={busy || Boolean(pending)} className="space-y-3">
        <legend className="font-medium">Workflow</legend>
        <Select
          value={workflowVersionId}
          onValueChange={(value) => {
            if (value !== null) setWorkflowVersionId(value);
          }}
        >
          <SelectTrigger aria-label="Workflow to start">
            <SelectValue>{workflow?.id ?? "Choose a workflow"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {active?.workflowVersions.map((entry) => (
              <SelectItem key={entry.versionId} value={entry.versionId}>
                {entry.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!active ? <p>Activate a definition before starting work.</p> : null}
        {v4 && sandboxCatalog?.supported ? (
          <label className="block space-y-1">
            <span>Execution environment</span>
            <Select
              value={sandboxKey}
              onValueChange={(value) => {
                if (value) setSandboxKey(value);
              }}
            >
              <SelectTrigger aria-label="Execution environment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="worker">Existing worker</SelectItem>
                {sandboxCatalog.profiles.map((profile) => (
                  <SelectItem
                    key={`${profile.profileId}:${profile.revision}`}
                    value={`${profile.profileId}:${profile.revision}`}
                  >
                    {profile.label} · {profile.revision.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sandbox ? (
              <span className="text-xs text-muted-foreground">
                Fresh Linux environment · checkout {sandbox.checkout.commit.slice(0, 12)} ·{" "}
                {sandbox.lifetimeSeconds / 60} minutes. Applies to manual starts; scheduled and
                GitHub triggers use their configured worker.
              </span>
            ) : null}
            {sandboxCatalog.error ? <span role="alert">{sandboxCatalog.error}</span> : null}
          </label>
        ) : null}
        {active && workflow ? (
          <details>
            <summary className="cursor-pointer text-sm">
              Review roles and settings for this new run
            </summary>
            <WorkflowConfiguration active={active} workflowId={workflow.id} />
          </details>
        ) : null}
        {binding.error ? <p role="alert">Worker binding unavailable: {binding.error}</p> : null}
        {defaultsQuery.error ? (
          <p role="alert">Execution defaults unavailable: {defaultsQuery.error}</p>
        ) : null}
        {parallel ? (
          <div className="space-y-2 border-l-2 pl-3 text-sm">
            <p>
              {v4
                ? "Modular workflow · Limits and technical retries follow the pinned definition"
                : `Parallel workflow · Up to ${execution?.maxParallelism} branches · ${execution?.maxRepairRounds} repair rounds`}
            </p>
            <label className="block space-y-1">
              <span>Repository commit SHA</span>
              <Input
                value={sandbox?.checkout.commit ?? revision}
                disabled={Boolean(sandbox)}
                onChange={(event) => setRevision(event.target.value)}
                placeholder="Full 40-character commit SHA"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The workflow starts from this pinned commit. Later steps use their explicit checkpoint
              basis. Checks must use cwd: ".".
            </p>
          </div>
        ) : null}
        {v4 ? (
          <details>
            <summary className="cursor-pointer text-sm">Custom workflow inputs</summary>
            <label className="mt-3 block space-y-1">
              <span className="text-sm">Workflow inputs (JSON object)</span>
              <Textarea
                value={workflowInputs}
                onChange={(event) => setWorkflowInputs(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Leave the default empty object unless this workflow requires inputs. Inputs are
                pinned for this run; use connection references for secrets.
              </span>
            </label>
          </details>
        ) : null}
        {target ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={target.status.providerReady ? "success" : "warning"}>
              {target.status.providerReady ? "Default worker ready" : target.status.providerState}
            </Badge>
            <span className="text-muted-foreground">{target.status.activeRuns} active runs</span>
          </div>
        ) : null}
        {configured ? (
          <p className="text-sm">
            {workers?.length
              ? `Worker pool: ${workers.length} authorized targets`
              : `Project: ${selectedProject?.title}`}{" "}
            · Fallback model: {model}
            {defaults &&
            projectId === defaults.projectId &&
            model === defaults.model &&
            checks === JSON.stringify(defaults.checks, null, 2) &&
            artifacts === JSON.stringify(defaults.requiredArtifacts, null, 2) &&
            JSON.stringify(workers) === JSON.stringify(defaults.workers)
              ? " · Saved repository defaults"
              : " · Unsaved settings"}
          </p>
        ) : (
          <p className="text-sm">
            Set up this repository's worker project and fallback model once, then reuse them for
            future work items.
          </p>
        )}
        <details open={!configured || undefined}>
          <summary className="cursor-pointer text-sm">Worker and run settings</summary>
          <div className="space-y-3 pt-3">
            {parallel && (
              <WorkerPoolPicker
                environmentId={environmentId}
                workers={workers}
                onChange={(value) => setWorkers(value ?? null)}
              />
            )}
            <fieldset className="space-y-2">
              <legend className="text-sm">Default worker project</legend>
              {target?.projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="worker-project"
                    checked={projectId === project.id}
                    onChange={() => setProjectId(project.id)}
                  />
                  <span className="min-w-0 break-words">
                    {project.title}
                    <span className="block break-all text-xs text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1">
              <span className="text-sm">Fallback Codex model</span>
              {target?.status.models?.length ? (
                <Select
                  value={model}
                  onValueChange={(value) => {
                    if (value !== null) setModel(value);
                  }}
                >
                  <SelectTrigger aria-label="Fallback Codex model">
                    <SelectValue>{model || "Choose an available model"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {target.status.models.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="Model for steps without a versioned model"
                />
              )}
            </label>
            <p className="text-xs text-muted-foreground">
              Role and step models take precedence. These operational defaults grant no accounts or
              permissions.
            </p>
            {!parallel ? (
              <label className="block space-y-1">
                <span className="text-sm">Advanced input reference</span>
                <Input value={revision} onChange={(event) => setRevision(event.target.value)} />
              </label>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm">Checks and required artifacts</summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  These bindings connect workflow check and artifact names to this repository.
                  Existing saved defaults are reused.
                </p>
                <label className="block space-y-1">
                  <span className="text-sm">Checks: id, prompt, command, cwd</span>
                  <Textarea value={checks} onChange={(event) => setChecks(event.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">Required artifacts: stepId, names</span>
                  <Textarea
                    value={artifacts}
                    onChange={(event) => setArtifacts(event.target.value)}
                  />
                </label>
              </div>
            </details>
          </div>
        </details>
      </fieldset>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          size="multiline"
          disabled={
            busy ||
            !canStart ||
            (!pending &&
              ((!sandbox && !workers?.length && !target?.status.providerReady) ||
                (parallel && !sandbox && !/^[a-f0-9]{40}$/i.test(revision)) ||
                !configured ||
                (!sandbox && !revision) ||
                !workflowVersionId ||
                defaultsQuery.loading ||
                Boolean(defaultsQuery.error))) ||
            (pending !== null && pending.op !== "start")
          }
          onClick={() => void submit("start")}
        >
          {busy ? "Saving…" : pending?.op === "start" ? "Retry the same start" : "Start workflow"}
        </Button>
        <Button
          variant="outline"
          size="multiline"
          disabled={
            busy ||
            !canConfigure ||
            (!pending &&
              (!configured ||
                !workflowVersionId ||
                defaultsQuery.loading ||
                Boolean(defaultsQuery.error))) ||
            (pending !== null && pending.op !== "configureExecutionDefaults")
          }
          onClick={() => void submit("save")}
        >
          {pending?.op === "configureExecutionDefaults"
            ? "Retry saving defaults"
            : "Use these settings for future starts"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Starting authorizes this run using the active definition and current worker permissions.
        Saved defaults and definition activation never start work automatically.
      </p>
      {!canStart ? (
        <p className="text-sm text-muted-foreground">
          Your connection does not have permission to start work.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
