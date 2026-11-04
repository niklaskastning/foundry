import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AutomationApplicationCommand,
  CanonicalFactoryDefinition,
  EnvironmentId,
  FactoryDefinitionVersion,
} from "@t3tools/contracts";
import { exportFactoryFiles, validateFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Result from "effect/Result";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";

type Step = CanonicalFactoryDefinition["workflows"][number]["steps"][number];
export function DefinitionEditor({
  environmentId,
  factoryId,
  scopeVersionId,
  repositories,
  active,
  onActivated,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  scopeVersionId: string;
  repositories: readonly string[];
  active: FactoryDefinitionVersion | null;
  onActivated: () => void;
}) {
  const [definition, setDefinition] = useState<CanonicalFactoryDefinition>(
    () =>
      active?.definition ?? {
        schemaVersion: 1,
        factoryId,
        repositories,
        workflows: [
          {
            id: "main",
            steps: [
              {
                id: "approval",
                kind: "approval",
                dependsOn: [],
                prompt: "Review and approve this work item.",
              },
            ],
          },
        ],
      },
  );
  const [filesText, setFilesText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AutomationApplicationCommand | null>(null);
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const permission = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "activateDefinition" }),
  );
  function replaceStep(workflowIndex: number, stepIndex: number, step: Step) {
    setPending(null);
    setDefinition({
      ...definition,
      workflows: definition.workflows.map((workflow, wi) =>
        wi === workflowIndex
          ? {
              ...workflow,
              steps: workflow.steps.map((current, si) => (si === stepIndex ? step : current)),
            }
          : workflow,
      ),
    });
  }
  function validate() {
    const validation = validateFactoryFiles(exportFactoryFiles(definition));
    setMessage(
      Result.isFailure(validation)
        ? validation.failure
            .map((issue) => `${issue.file}: ${issue.path.join(".")} ${issue.message}`)
            .join("\n")
        : "Definition is valid. Activation does not start a run.",
    );
    return Result.isSuccess(validation);
  }
  async function activate() {
    if (busy || !validate()) return;
    const input = pending ?? {
      op: "activateDefinition" as const,
      input: {
        commandId: randomUUID(),
        factoryId,
        scopeVersionId,
        expectedVersionId: active?.id ?? null,
        files: exportFactoryFiles(definition),
        source: { kind: "foundry" as const, reference: "form-editor" },
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
    if (AsyncResult.isSuccess(response)) {
      setMessage("Definition activated. Existing runs retain their pinned version.");
      setPending(null);
      onActivated();
    } else
      setMessage(
        "Activation failed. Check your permissions and refresh the current version before editing. Retry sends the same command.",
      );
  }
  return (
    <section className="space-y-4" aria-label="Factory definition">
      <div>
        <h2 className="text-lg font-medium">Definition</h2>
        <p className="text-sm text-muted-foreground">
          {active ? `Active version: ${active.id}` : "No active definition"}
        </p>
      </div>
      <p className="text-sm">Repositories: {repositories.join(", ")}</p>
      {definition.workflows.map((workflow, wi) => (
        <fieldset key={workflow.id} className="space-y-3 rounded-lg border p-3">
          <legend className="px-1 text-sm">Workflow {wi + 1}</legend>
          <label className="block space-y-1">
            <span className="text-sm">Workflow key</span>
            <Input
              defaultValue={workflow.id}
              onBlur={(event) => {
                setPending(null);
                setDefinition({
                  ...definition,
                  workflows: definition.workflows.map((item, index) =>
                    index === wi ? { ...item, id: event.target.value } : item,
                  ),
                });
              }}
            />
          </label>
          {workflow.steps.map((step, si) => (
            <fieldset key={step.id} className="space-y-2 rounded border p-3">
              <legend className="px-1 text-sm">
                Step {si + 1} · {step.kind}
              </legend>
              <label className="block space-y-1">
                <span className="text-sm">Step key</span>
                <Input
                  defaultValue={step.id}
                  onBlur={(event) => replaceStep(wi, si, { ...step, id: event.target.value })}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">Depends on (comma separated step keys)</span>
                <Input
                  value={step.dependsOn.join(", ")}
                  onChange={(event) =>
                    replaceStep(wi, si, {
                      ...step,
                      dependsOn: event.target.value
                        .split(",")
                        .map((id) => id.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              {step.kind === "agent" || step.kind === "approval" ? (
                <label className="block space-y-1">
                  <span className="text-sm">Instructions</span>
                  <Textarea
                    value={step.prompt}
                    onChange={(event) =>
                      replaceStep(wi, si, { ...step, prompt: event.target.value })
                    }
                  />
                </label>
              ) : step.kind === "test" ? (
                <label className="block space-y-1">
                  <span className="text-sm">Check binding key</span>
                  <Input
                    value={step.checkId}
                    onChange={(event) =>
                      replaceStep(wi, si, { ...step, checkId: event.target.value })
                    }
                  />
                </label>
              ) : (
                <p className="text-sm">
                  Pull request publication requires a future publishing adapter.
                </p>
              )}
              <Button
                variant="ghost"
                disabled={workflow.steps.length === 1}
                onClick={() => {
                  setPending(null);
                  setDefinition({
                    ...definition,
                    workflows: definition.workflows.map((item, index) =>
                      index === wi
                        ? { ...item, steps: item.steps.filter((_, index) => index !== si) }
                        : item,
                    ),
                  });
                }}
              >
                Remove step
              </Button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            {(["agent", "test", "approval", "publish"] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                onClick={() => {
                  const base = {
                    id: `${kind}-${workflow.steps.length + 1}`,
                    dependsOn: workflow.steps.at(-1) ? [workflow.steps.at(-1)!.id] : [],
                  };
                  const step: Step =
                    kind === "test"
                      ? { ...base, kind, checkId: "check" }
                      : kind === "publish"
                        ? { ...base, kind, target: "pull_request" }
                        : { ...base, kind, prompt: "Describe the required work." };
                  setPending(null);
                  setDefinition({
                    ...definition,
                    workflows: definition.workflows.map((item, index) =>
                      index === wi ? { ...item, steps: [...item.steps, step] } : item,
                    ),
                  });
                }}
              >
                Add {kind}
              </Button>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onActivated}>
          Reload active version
        </Button>
        <Button variant="outline" onClick={validate}>
          Validate
        </Button>
        <Button disabled={busy || !permission} onClick={() => void activate()}>
          {busy ? "Activating…" : pending ? "Retry activation" : "Activate definition"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setFilesText(JSON.stringify(exportFactoryFiles(definition), null, 2))}
        >
          Export files
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Import / export definition files</summary>
        <div className="space-y-2 pt-2">
          <Textarea
            aria-label="Definition files JSON"
            value={filesText}
            onChange={(event) => setFilesText(event.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => {
              try {
                const parsed = validateFactoryFiles(JSON.parse(filesText));
                if (Result.isFailure(parsed))
                  setMessage(
                    parsed.failure.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
                  );
                else {
                  setDefinition(parsed.success);
                  setPending(null);
                  setMessage("Imported locally. Validate and activate to save this version.");
                }
              } catch {
                setMessage("Enter an array of {path, content} definition files.");
              }
            }}
          >
            Import files
          </Button>
        </div>
      </details>
      {message ? (
        <p role="status" className="whitespace-pre-wrap text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
