import { V4WorkflowConfiguration } from "./V4Configuration";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AutomationApplicationCommand,
  CanonicalFactoryDefinition,
  LegacyCanonicalFactoryDefinition,
  EnvironmentId,
  FactoryDefinitionVersion,
} from "@t3tools/contracts";
import {
  exportFactoryFiles,
  validateFactoryFiles,
  migrateFactoryDefinitionV4,
} from "@t3tools/shared/factoryDefinition";
import * as Result from "effect/Result";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";

type Step = LegacyCanonicalFactoryDefinition["workflows"][number]["steps"][number];
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
    if (definition.schemaVersion === 4) return;
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
        "Activation failed. Check your permissions and refresh the current version before editing. Unconfirmed requests retain their command ID.",
      );
  }
  if (definition.schemaVersion === 4)
    return (
      <section className="space-y-4" aria-label="Factory definition">
        <h2 className="text-lg font-medium">Modular definition draft · v4</h2>
        <p className="text-sm">
          Review the complete file bundle before activation. Existing runs keep their pinned
          resources.
        </p>
        {definition.workflows.map((workflow) => (
          <details key={workflow.id} className="rounded-lg border p-3">
            <summary className="cursor-pointer">{workflow.id}</summary>
            <V4WorkflowConfiguration definition={definition} workflow={workflow} />
          </details>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={validate}>
            Validate
          </Button>
          <Button disabled={busy || !permission} onClick={() => void activate()}>
            Activate reviewed draft
          </Button>
          <Button
            variant="outline"
            onClick={() => setFilesText(JSON.stringify(exportFactoryFiles(definition), null, 2))}
          >
            Export files
          </Button>
          <Button variant="outline" onClick={onActivated}>
            Reload active version
          </Button>
        </div>
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
                setMessage("Imported locally. Review and activate explicitly.");
              }
            } catch {
              setMessage("Enter a valid definition file bundle.");
            }
          }}
        >
          Import reviewed files
        </Button>
        {message ? (
          <p role="status" className="whitespace-pre-wrap text-sm">
            {message}
          </p>
        ) : null}
      </section>
    );
  return (
    <section className="space-y-4" aria-label="Factory definition">
      <div>
        <h2 className="text-lg font-medium">Definition draft</h2>
        <p className="text-sm text-muted-foreground">
          {active
            ? "Editing a local draft of the active definition"
            : "Create the first definition for this factory"}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Validate your draft, then activate it for new runs. Existing runs keep their pinned version.
        Git-owned definitions are edited in their repository.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer">Active version and repository scope</summary>
        <div className="space-y-2 break-all pt-2 text-muted-foreground">
          <p>Active version: {active?.id ?? "None"}</p>
          <p>Repositories: {repositories.join(", ")}</p>
          <p>
            After binding a Git source, local edits change the import basis and must be reconciled
            before import.
          </p>
        </div>
      </details>
      {!permission ? (
        <p role="status" className="text-sm text-muted-foreground">
          Read-only access. You can inspect or export a draft, but cannot activate it.
        </p>
      ) : null}
      {definition.workflows.map((workflow, wi) => (
        <details
          key={workflow.id}
          open={definition.workflows.length === 1}
          className="rounded-lg border p-4"
        >
          <summary className="cursor-pointer font-medium">
            {workflow.id} · {workflow.steps.length} steps
          </summary>
          <fieldset className="space-y-3 pt-4">
            <legend className="sr-only">Workflow {wi + 1}</legend>
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
                    Publishes the tested commit as a pull request after approval for that revision.
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
        </details>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onActivated}>
          Reload active version
        </Button>
        <Button variant="outline" onClick={validate}>
          Validate
        </Button>
        <Button disabled={busy || !permission} onClick={() => void activate()}>
          {busy ? "Activating…" : pending ? "Retry activation" : "Activate draft"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setFilesText(JSON.stringify(exportFactoryFiles(definition), null, 2))}
        >
          Export files
        </Button>
      </div>
      <Button
        variant="outline"
        onClick={() => {
          try {
            setFilesText(JSON.stringify(migrateFactoryDefinitionV4(definition), null, 2));
            setMessage(
              "Migration exported for review. Import it explicitly to prepare activation; the active definition is unchanged.",
            );
          } catch {
            setMessage(
              "This definition could not be migrated. Review its resource IDs and execution policy.",
            );
          }
        }}
      >
        Prepare v4 migration for review
      </Button>
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
