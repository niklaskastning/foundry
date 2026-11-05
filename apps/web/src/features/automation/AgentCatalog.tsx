import type { FactoryDefinitionVersion } from "@t3tools/contracts";
import { resolveFactoryWorkflow } from "@t3tools/shared/factoryDefinition";

export function AgentCatalog({ active }: { active: FactoryDefinitionVersion | null }) {
  if (!active)
    return (
      <p className="text-sm">Activate a definition to see its agents, skills and workflows.</p>
    );
  const definition = active.definition;
  const roles = definition.roles ?? [];
  return (
    <section className="space-y-4" aria-label="Factory agents and skills">
      <div>
        <h2 className="text-lg font-medium">Agents & skills</h2>
        <p className="text-sm text-muted-foreground">
          Reusable roles from the active definition. Workflow steps add their concrete task.
        </p>
      </div>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        {active.source.kind === "github" ? (
          <>
            <p>
              Source: {active.source.repository} · {active.source.branch}
            </p>
            <a
              className="underline"
              href={`https://github.com/${active.source.repository}/tree/${encodeURIComponent(active.source.branch)}/${active.source.path.split("/").map(encodeURIComponent).join("/")}`}
              target="_blank"
              rel="noreferrer"
            >
              Change agents and skills in Git / open a pull request
            </a>
            <p className="text-xs text-muted-foreground">
              Sync imports changes; explicit activation applies them to new runs. Existing runs
              retain their pinned configuration.
            </p>
          </>
        ) : (
          <p>
            This definition is locally imported. Configure its Git source under Definition to manage
            changes through pull requests.
          </p>
        )}
        <details>
          <summary className="cursor-pointer">Active version and source revision</summary>
          <div className="space-y-1 break-all pt-2">
            <p>{active.id}</p>
            <p>Content: {active.contentHash}</p>
            {active.source.kind === "github" ? <p>Commit: {active.source.commitSha}</p> : null}
          </div>
        </details>
      </div>
      <p className="text-sm">
        Execution: Codex · versioned instruction skills · model and reasoning settings. Worker
        project, accounts and permissions are configured separately. MCP, secret and connector
        adapters are not available in this slice.
      </p>
      <p className="text-xs text-muted-foreground">
        Settings resolve in order: factory defaults → role settings → step overrides. A missing
        model uses the explicitly configured worker binding.
      </p>
      {roles.length === 0 ? (
        <p className="text-sm">
          This definition uses prompt steps without reusable roles. Its existing workflows remain
          available.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.map((role) => (
          <article key={role.id} className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">{role.name}</h3>
            <p className="text-sm">{role.description}</p>
            <p className="whitespace-pre-wrap text-sm">{role.instructions}</p>
            <p className="text-sm">
              Skills:{" "}
              {role.skills.length
                ? role.skills
                    .map((id) => definition.skills?.find((skill) => skill.id === id)?.name ?? id)
                    .join(", ")
                : "None"}
            </p>
            <p className="text-sm">
              Model:{" "}
              {role.execution?.model ?? definition.defaults?.model ?? "Worker binding default"} ·
              Reasoning:{" "}
              {role.execution?.options?.reasoningEffort ??
                definition.defaults?.options?.reasoningEffort ??
                "Provider default"}
            </p>
            <p className="text-xs text-muted-foreground">
              Used by:{" "}
              {definition.workflows
                .filter((workflow) =>
                  workflow.steps.some((step) => step.kind === "agent" && step.role === role.id),
                )
                .map((workflow) => workflow.id)
                .join(", ") || "No workflows"}
            </p>
          </article>
        ))}
      </div>
      {definition.skills?.length ? (
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
      <section className="space-y-3" aria-label="Effective workflow settings">
        <h3 className="font-medium">Effective workflow settings</h3>
        {definition.workflows.map((workflow) => (
          <details key={workflow.id} className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">{workflow.id}</summary>
            <WorkflowConfiguration active={active} workflowId={workflow.id} />
          </details>
        ))}
      </section>
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
              <p className="whitespace-pre-wrap">{step.prompt}</p>
              <p>
                Codex · {step.resolved?.execution.model ?? "Worker binding default"} ·{" "}
                {step.resolved?.execution.options?.reasoningEffort ?? "Provider reasoning default"}
              </p>
              <p>Skills: {step.resolved?.skills.map((skill) => skill.name).join(", ") || "None"}</p>
              {step.execution ? (
                <p className="text-xs text-muted-foreground">
                  Step overrides: {JSON.stringify(step.execution)}
                </p>
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
