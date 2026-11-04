import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  ProjectId,
  ManualStart,
  type AutomationApplicationCommand,
  type EnvironmentId,
  type FactoryDefinitionVersion,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { RunList } from "./RunList";

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
  const binding = useAutomationQuery(environmentId, { op: "workerBinding" });
  const target = binding.result?.kind === "workerBinding" ? binding.result : null;
  const work = useAutomationQuery(environmentId, { op: "workItem", factoryId, workItemId });
  const [workflowVersionId, setWorkflowVersionId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [revision, setRevision] = useState("");
  const [checks, setChecks] = useState("[]");
  const [artifacts, setArtifacts] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const canStart = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  async function start() {
    if (busy || !projectId || !model || !revision || !workflowVersionId) return;
    let input: AutomationApplicationCommand;
    try {
      input = pending ?? {
        op: "start",
        input: decodeManualStart({
          commandId: randomUUID(),
          id: randomUUID(),
          factoryId,
          workItemId,
          workflowVersionId,
          revision,
          projectId: ProjectId.make(projectId),
          model,
          checks: JSON.parse(checks),
          requiredArtifacts: JSON.parse(artifacts),
        }),
      };
    } catch {
      setMessage(
        "Check the start fields. Checks require id, prompt, command and cwd; artifact bindings require stepId and names.",
      );
      return;
    }
    setPending(input);
    setBusy(true);
    const result = await command({ environmentId, input });
    setBusy(false);
    if (
      AsyncResult.isFailure(result) &&
      isDefinitiveAutomationFailure(squashAtomCommandFailure(result))
    )
      setPending(null);
    if (AsyncResult.isSuccess(result) && result.value.kind === "run") {
      setPending(null);
      onOpenRun(factoryId, result.value.run.id);
    } else
      setMessage(
        "Start was not confirmed. Verify the worker/project binding and permissions. Unconfirmed requests retain their command and run ID.",
      );
  }
  return (
    <section className="space-y-4" aria-label="Work item detail">
      {work.error ? <p role="alert">{work.error}</p> : null}
      {work.result?.kind === "workItem" ? (
        <>
          <h2 className="text-lg font-medium">{work.result.item.title}</h2>
          <p className="text-sm">
            {work.result.item.state} · {work.result.item.repository}
          </p>
        </>
      ) : null}
      <fieldset disabled={busy || Boolean(pending)} className="space-y-3 rounded-lg border p-3">
        <legend className="px-1">Start a workflow manually</legend>
        <p className="text-xs text-muted-foreground">
          Choose an activated workflow and an explicit project on the configured worker. Starting
          authorizes this run only; activating a definition never starts existing runs.
        </p>
        <div className="flex flex-wrap gap-2">
          {active?.workflowVersions.map((workflow) => (
            <Button
              key={workflow.versionId}
              variant={workflowVersionId === workflow.versionId ? "default" : "outline"}
              onClick={() => setWorkflowVersionId(workflow.versionId)}
            >
              {workflow.id}
            </Button>
          ))}
        </div>
        {binding.error ? <p role="alert">Worker binding unavailable: {binding.error}</p> : null}
        {target ? (
          <>
            <p className="text-sm">
              Worker: {target.environmentId} · {target.status.providerState} ·{" "}
              {target.status.activeRuns} active runs
            </p>
            <fieldset className="space-y-2">
              <legend className="text-sm">Choose worker project</legend>
              {target.projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="worker-project"
                    checked={projectId === project.id}
                    onChange={() => setProjectId(project.id)}
                  />
                  <span>
                    {project.title} · {project.workspaceRoot}
                  </span>
                </label>
              ))}
            </fieldset>
          </>
        ) : null}
        <label className="block space-y-1">
          <span className="text-sm">Model on the bound provider</span>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Enter the intended model explicitly"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Input revision</span>
          <Input
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            placeholder="The input revision you intend to execute"
          />
        </label>
        <details>
          <summary className="cursor-pointer text-sm">Check and artifact bindings</summary>
          <div className="space-y-2 pt-2">
            <label className="block space-y-1">
              <span className="text-sm">Checks: id, prompt, command, cwd</span>
              <Textarea value={checks} onChange={(event) => setChecks(event.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">Required artifacts: stepId, names</span>
              <Textarea value={artifacts} onChange={(event) => setArtifacts(event.target.value)} />
            </label>
          </div>
        </details>
      </fieldset>
      <Button
        disabled={
          busy ||
          !canStart ||
          !target?.status.providerReady ||
          !workflowVersionId ||
          !projectId ||
          !model ||
          !revision
        }
        onClick={() => void start()}
      >
        {busy ? "Starting…" : pending ? "Retry the same start" : "Start this workflow"}
      </Button>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <RunList
        environmentId={environmentId}
        factoryId={factoryId}
        workItemId={workItemId}
        onOpen={onOpenRun}
      />
    </section>
  );
}
