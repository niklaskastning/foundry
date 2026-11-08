import { V4Catalog, V4WorkflowConfiguration } from "./V4Configuration";
import type { FactoryDefinitionVersion } from "@t3tools/contracts";
import { resolveFactoryWorkflow } from "@t3tools/shared/factoryDefinition";

export function AgentCatalog({ active }: { active: FactoryDefinitionVersion | null }) {
  if (!active)
    return (
      <p className="text-sm">Activate a definition to see its agents, skills and workflows.</p>
    );
  const definition = active.definition;
  const roles = definition.schemaVersion === 4 ? [] : (definition.roles ?? []);
  return (
    <section className="space-y-6" aria-label="Factory agents and skills">
      <div>
        <h2 className="text-lg font-semibold">Agents & skills</h2>
        <p className="text-sm text-muted-foreground">
          Reusable agents for new runs. Each workflow adds its task and execution settings.
        </p>
      </div>
      {definition.schemaVersion === 4 ? <V4Catalog definition={definition} /> : null}
      {roles.length === 0 && definition.schemaVersion !== 4 ? (
        <p className="text-sm">
          This definition uses prompt steps without reusable roles. Its existing workflows remain
          available.
        </p>
      ) : null}
      <div className="divide-y border-y">
        {roles.map((role) => (
          <article key={role.id} className="min-w-0 space-y-3 py-4">
            <h3 className="text-base font-semibold">{role.name}</h3>
            <p className="text-sm">{role.description}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Model / reasoning</dt>
                <dd className="mt-1 break-words">
                  {role.execution?.model ??
                    (definition.schemaVersion !== 4 ? definition.defaults?.model : undefined) ??
                    "Worker binding default"}
                  {" · "}
                  {role.execution?.options?.reasoningEffort ??
                    (definition.schemaVersion !== 4
                      ? definition.defaults?.options?.reasoningEffort
                      : undefined) ??
                    "Provider default"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Skills</dt>
                <dd className="mt-1 break-words">
                  {role.skills.length
                    ? role.skills
                        .map(
                          (id) => definition.skills?.find((skill) => skill.id === id)?.name ?? id,
                        )
                        .join(", ")
                    : "No additional skills"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Used in workflows</dt>
                <dd className="mt-1 break-words">
                  {definition.workflows
                    .filter((workflow) =>
                      workflow.steps.some(
                        (step) => step.kind === "agent" && "role" in step && step.role === role.id,
                      ),
                    )
                    .map((workflow) => workflow.id)
                    .join(", ") || "Not used by a workflow yet"}
                </dd>
              </div>
            </dl>
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-sm font-medium">
                Full role instructions
              </summary>
              <p className="whitespace-pre-wrap break-words pt-3 text-sm">{role.instructions}</p>
            </details>
          </article>
        ))}
      </div>
      {definition.schemaVersion !== 4 && definition.skills?.length ? (
        <section className="space-y-2" aria-label="Versioned skills">
          <h3 className="font-medium">Versioned instruction skills</h3>
          {definition.skills.map((skill) => (
            <details key={skill.id} className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">{skill.name}</summary>
              <p className="whitespace-pre-wrap pt-2 text-sm">{skill.instructions}</p>
            </details>
          ))}
        </section>
      ) : null}
      <section className="space-y-3" aria-label="Active definition source">
        <h3 className="font-medium">Active definition</h3>
        <p className="text-sm text-muted-foreground">
          Changes apply to new runs after activation. A run's own details show its pinned
          configuration.
        </p>
        {active.source.kind === "github" ? (
          <a
            className="inline-block break-all text-sm underline underline-offset-4"
            href={`https://github.com/${active.source.repository}/tree/${encodeURIComponent(active.source.commitSha)}/${active.source.path.split("/").map(encodeURIComponent).join("/")}`}
            target="_blank"
            rel="noreferrer"
          >
            View pinned Git definition · {active.source.repository}
          </a>
        ) : (
          <p className="text-sm">
            Locally managed. Open Definition to edit or connect a Git repository.
          </p>
        )}
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer">Revision and configuration rules</summary>
          <div className="space-y-2 break-words pt-3 text-muted-foreground">
            <p>
              {definition.schemaVersion === 4
                ? "Settings: factory → agent → workflow → step. Resources are added without changing the base agent."
                : "Settings: factory defaults → role settings → step overrides."}{" "}
              A missing model uses the worker binding.
            </p>
            <p>
              Execution uses Codex with checked capabilities. Worker projects, MCP authorization and
              permissions are configured separately.
            </p>
            <dl className="space-y-2">
              <div>
                <dt>Active version</dt>
                <dd className="break-all">{active.id}</dd>
              </div>
              <div>
                <dt>Content revision</dt>
                <dd className="break-all">{active.contentHash}</dd>
              </div>
              {active.source.kind === "github" ? (
                <div>
                  <dt>Git commit</dt>
                  <dd className="break-all">{active.source.commitSha}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </details>
      </section>
    </section>
  );
}

export function WorkflowCatalog({ active }: { active: FactoryDefinitionVersion | null }) {
  return (
    <section className="space-y-5" aria-label="Factory workflows">
      <div>
        <h2 className="text-lg font-semibold">Workflows</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Follow the work from its first step to review and delivery. This is the active definition
          for new runs.
        </p>
      </div>
      {active ? (
        <div className="divide-y border-y">
          {active.definition.workflows.map((workflow) => (
            <details
              key={workflow.id}
              open={active.definition.workflows.length === 1}
              className="py-4"
            >
              <summary className="cursor-pointer font-medium">
                {workflow.id}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {" "}
                  · {workflow.steps.length} top-level steps
                </span>
              </summary>
              <WorkflowConfiguration active={active} workflowId={workflow.id} />
            </details>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Activate a definition to see the workflow and its agents.
        </p>
      )}
    </section>
  );
}

export function WorkflowConfiguration({
  active,
  workflowId,
}: {
  active: FactoryDefinitionVersion;
  workflowId: string;
}) {
  if (active.definition.schemaVersion === 4) {
    const workflow = active.definition.workflows.find((item) => item.id === workflowId);
    return workflow ? (
      <V4WorkflowConfiguration definition={active.definition} workflow={workflow} />
    ) : null;
  }
  const steps = resolveFactoryWorkflow(active.definition, workflowId);
  return (
    <ol className="space-y-3 pt-3 text-sm">
      {steps.map((step, index) => (
        <li key={step.id} className="space-y-1 border-l-2 pl-3">
          <p className="font-medium">
            {index + 1}. {step.id} ·{" "}
            {step.kind === "agent" ? (step.resolved?.role?.name ?? "Agent") : step.kind}
          </p>
          {step.kind === "agent" ? (
            <>
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  Task instructions
                </summary>
                <p className="whitespace-pre-wrap break-words pt-2">{step.prompt}</p>
              </details>
              <p>
                Codex · {step.resolved?.execution.model ?? "Worker binding default"} ·{" "}
                {step.resolved?.execution.options?.reasoningEffort ?? "Provider reasoning default"}
              </p>
              <p>Skills: {step.resolved?.skills.map((skill) => skill.name).join(", ") || "None"}</p>
              {step.execution ? (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Step overrides</summary>
                  <pre className="overflow-x-auto pt-2">
                    {JSON.stringify(step.execution, null, 2)}
                  </pre>
                </details>
              ) : null}
              {step.resolved?.instructions ? (
                <details>
                  <summary className="cursor-pointer">
                    Effective role and skill instructions
                  </summary>
                  <p className="whitespace-pre-wrap pt-2">{step.resolved.instructions}</p>
                </details>
              ) : null}
            </>
          ) : step.kind === "approval" ? (
            <p>{step.prompt}</p>
          ) : step.kind === "test" ? (
            <p>Required check: {step.checkId}</p>
          ) : (
            <p>Publish a pull request after its required evidence and approval.</p>
          )}
        </li>
      ))}
    </ol>
  );
}
