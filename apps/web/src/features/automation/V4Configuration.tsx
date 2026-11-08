import { FoundryUI } from "../../foundry/FoundryUI";
import { Badge } from "../../components/ui/badge";
import type {
  CanonicalFactoryDefinitionV4,
  FactoryV4Node,
  FactoryV4ResolvedAgent,
  FactoryV4Snapshot,
  FactoryV4Workflow,
} from "@t3tools/contracts";
import { resolveFactoryV4Agent } from "@t3tools/shared/factoryDefinition";

export function V4AgentConfiguration({
  agent,
}: {
  agent: Pick<FactoryV4ResolvedAgent, "agent" | "instructions" | "execution" | "provenance">;
}) {
  return (
    <div className="min-w-0 space-y-3 break-words text-sm">
      <p>
        {agent.agent.name} · Codex · {agent.execution.model ?? "Worker binding default"} ·{" "}
        {agent.execution.options?.reasoningEffort ?? "Provider reasoning default"}
      </p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Skills and origin</dt>
          <dd>
            {agent.provenance.skills
              .map((resource) => `${resource.id} (${resource.sources.join(" → ")})`)
              .join(", ") || "None"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">MCP and origin</dt>
          <dd>
            {agent.provenance.mcp
              .map((resource) => `${resource.id} (${resource.sources.join(" → ")})`)
              .join(", ") || "None"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Execution sources</dt>
          <dd>
            Provider: {agent.provenance.execution.provider} · Model:{" "}
            {agent.provenance.execution.model ?? "Worker binding"} · Reasoning:{" "}
            {agent.provenance.execution.reasoningEffort ?? "Provider default"}
          </dd>
        </div>
      </dl>
      <details>
        <FoundryUI.Summary className="cursor-pointer">
          Instructions and their origins
        </FoundryUI.Summary>
        <ol className="space-y-3 pt-2">
          {[...new Set(agent.provenance.instructions.map((part) => part.source))].map((source) => (
            <li key={source}>
              <p className="font-medium">{source}</p>
              <p className="whitespace-pre-wrap break-words">
                {agent.provenance.instructions
                  .filter((part) => part.source === source)
                  .map((part) => part.value)
                  .join("\n\n")}
              </p>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function WorkflowNodes({
  nodes,
  snapshot,
}: {
  nodes: readonly FactoryV4Node[];
  snapshot: FactoryV4Snapshot;
}) {
  return (
    <ol className="divide-y border-l border-border">
      {nodes.map((node) => (
        <li key={node.id} className="min-w-0 space-y-2 py-3 pl-3 sm:pl-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-medium">{node.id}</span>
            <Badge
              variant={
                node.kind === "approval"
                  ? "warning"
                  : node.kind === "swarm" || node.kind === "loop"
                    ? "info"
                    : "secondary"
              }
            >
              {node.kind === "swarm"
                ? "Parallel branches"
                : node.kind === "loop"
                  ? "Review / fix rounds"
                  : node.kind === "approval"
                    ? "Human decision"
                    : node.kind === "publish"
                      ? "Publish PR"
                      : node.kind === "test"
                        ? "Check"
                        : "Agent"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {node.dependsOn.length
              ? `After ${node.dependsOn.join(", ")}`
              : "Starts when this group begins"}
            {node.dependsOn.length
              ? node.dependencyPolicy === "terminal"
                ? " · waits for completion, including failures"
                : " · requires success"
              : ""}
          </p>
          {node.when ? (
            <details>
              <FoundryUI.Summary className="cursor-pointer text-sm">Condition</FoundryUI.Summary>
              <pre className="overflow-auto text-xs">{JSON.stringify(node.when, null, 2)}</pre>
            </details>
          ) : null}
          {node.kind === "agent" ? (
            <>
              <p className="text-sm text-muted-foreground">
                {snapshot.agents.find((agent) => agent.id === node.agent)?.name ?? node.agent}
                {node.workspace
                  ? ` · ${node.workspace.access === "write" ? "Can change files" : "Read-only workspace"}`
                  : ""}
                {node.retry ? ` · up to ${node.retry.maxAttempts} technical attempts` : ""}
              </p>
              {node.extend?.skills?.length ||
              node.extend?.mcp?.length ||
              node.extend?.instructions ? (
                <p className="text-xs text-muted-foreground">
                  Step additions:{" "}
                  {[
                    ...(node.extend.skills ?? []).map(
                      (id) => snapshot.skills.find((item) => item.id === id)?.name ?? id,
                    ),
                    ...(node.extend.mcp ?? []).map(
                      (id) => snapshot.mcp.find((item) => item.id === id)?.name ?? id,
                    ),
                    ...(node.extend.instructions ? ["extra instructions"] : []),
                  ].join(", ")}
                </p>
              ) : null}
              <details className="text-sm">
                <FoundryUI.Summary className="cursor-pointer">
                  Task, resources and effective settings
                </FoundryUI.Summary>
                <div className="pt-3">
                  <V4AgentConfiguration agent={resolveFactoryV4Agent(snapshot, node)} />
                </div>
              </details>
            </>
          ) : null}
          {node.kind === "swarm" ? (
            <p className="text-sm">
              Up to {node.maxParallel} agents at once. Continue after{" "}
              {node.join.policy === "quorum"
                ? `${node.join.minSuccesses} successful branches`
                : "all branches succeed"}
              .{" "}
              {node.join.onFailure === "cancel_remaining"
                ? "Cancel remaining branches on failure."
                : "Collect remaining results on failure."}
            </p>
          ) : null}
          {node.kind === "loop" ? (
            <>
              <p className="text-sm">
                Up to {node.maxIterations} rounds.{" "}
                {node.onExhausted === "approval"
                  ? "Ask for a decision if the goal is still unmet."
                  : "Fail if the goal is still unmet."}{" "}
                Technical retries are counted separately.
              </p>
              <details>
                <FoundryUI.Summary className="cursor-pointer text-sm">
                  Stop condition and carried values
                </FoundryUI.Summary>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(
                    {
                      until: node.until,
                      carry: node.carry,
                      nextCarry: node.nextCarry,
                      workspaceFrom: node.workspaceFrom,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          ) : null}
          {node.kind === "loop" || node.kind === "swarm" ? (
            <WorkflowNodes nodes={node.steps} snapshot={snapshot} />
          ) : null}
          {node.kind === "test" ? <p className="text-sm">Required check: {node.checkId}</p> : null}
          {node.kind === "approval" ? (
            <p className="text-sm whitespace-pre-wrap">{node.instructions}</p>
          ) : null}
          {node.kind === "publish" ? (
            <p className="text-sm">Publish the tested and approved checkpoint as a pull request.</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function V4WorkflowConfiguration({
  definition,
  workflow,
}: {
  definition: CanonicalFactoryDefinitionV4;
  workflow: FactoryV4Workflow;
}) {
  return (
    <div className="space-y-3 pt-3">
      <p className="text-xs text-muted-foreground">
        Execution budget: {workflow.limits.maxConcurrentAgents} concurrent agents ·{" "}
        {workflow.limits.maxAgentExecutions} total starts including technical retries
      </p>
      {workflow.agentDefaults?.extend ? (
        <p className="text-xs text-muted-foreground">
          Added to agents in this workflow:{" "}
          {[
            ...(workflow.agentDefaults.extend.skills ?? []).map(
              (id) => definition.skills.find((item) => item.id === id)?.name ?? id,
            ),
            ...(workflow.agentDefaults.extend.mcp ?? []).map(
              (id) => definition.mcp.find((item) => item.id === id)?.name ?? id,
            ),
            ...(workflow.agentDefaults.extend.instructions ? ["workflow instructions"] : []),
          ].join(", ") || "No additional resources"}
          .
        </p>
      ) : null}
      <WorkflowNodes nodes={workflow.steps} snapshot={{ ...definition, workflow }} />
    </div>
  );
}

export function V4Catalog({ definition }: { definition: CanonicalFactoryDefinitionV4 }) {
  return (
    <div className="space-y-6">
      <section className="grid gap-3 lg:grid-cols-2" aria-label="Versioned agents">
        <h3 className="font-medium lg:col-span-2">Agents</h3>
        {definition.agents.map((agent) => (
          <article key={agent.id} className="space-y-3 rounded-lg border bg-muted/10 p-4">
            <h4 className="font-medium">{agent.name}</h4>
            <p className="text-sm">{agent.description}</p>
            <p className="text-xs text-muted-foreground">
              Codex ·{" "}
              {agent.execution?.model ??
                definition.defaults?.execution.model ??
                "Worker binding default"}
              {" · "}
              {agent.execution?.options?.reasoningEffort ??
                definition.defaults?.execution.options?.reasoningEffort ??
                "Provider reasoning default"}
            </p>
            <p className="text-sm">
              Skills:{" "}
              {agent.skills
                .map((id) => definition.skills.find((item) => item.id === id)?.name ?? id)
                .join(", ") || "None"}
              {" · "}MCP:{" "}
              {agent.mcp
                .map((id) => definition.mcp.find((item) => item.id === id)?.name ?? id)
                .join(", ") || "None"}
            </p>
            <details>
              <FoundryUI.Summary className="cursor-pointer text-sm">
                Instructions and source
              </FoundryUI.Summary>
              <p className="pt-2 text-xs text-muted-foreground">agents/{agent.id}.yaml</p>
              <p className="whitespace-pre-wrap pt-2 text-sm">{agent.instructions}</p>
            </details>
          </article>
        ))}
      </section>
      <section className="space-y-3" aria-label="Versioned skill bundles">
        <h3 className="font-medium">Skill bundles</h3>
        {definition.skills.map((skill) => (
          <details key={skill.id} className="rounded-lg border bg-muted/10 p-4">
            <FoundryUI.Summary className="cursor-pointer text-sm">
              {skill.name} · {skill.files.length} files
            </FoundryUI.Summary>
            <p className="py-2 text-sm">{skill.description}</p>
            <ul className="space-y-1 text-xs">
              {skill.files.map((file) => (
                <li key={file.path} className="break-all">
                  {file.path} · {file.mode} · SHA-256 {file.sha256}
                </li>
              ))}
            </ul>
          </details>
        ))}
        {definition.skills.length === 0 ? (
          <p className="text-sm">No skill bundles registered.</p>
        ) : null}
      </section>
      <section className="space-y-3" aria-label="Versioned MCP definitions">
        <h3 className="font-medium">MCP connections required by agents</h3>
        <p className="text-sm text-muted-foreground">
          Definitions request tools. Runtime bindings must authorize them before an agent can start.
        </p>
        {definition.mcp.map((mcp) => (
          <article key={mcp.id} className="space-y-3 rounded-lg border bg-muted/10 p-4 text-sm">
            <h4 className="font-medium">
              {mcp.name} · {mcp.transport}
            </h4>
            <p className="text-xs text-muted-foreground">mcp/{mcp.id}.yaml</p>
            <p>Requested tools: {mcp.allowedTools.join(", ") || "None"}</p>
            <p>
              Connection references:{" "}
              {mcp.transport === "streamable-http"
                ? (mcp.auth?.connection ?? "No authentication requested")
                : Object.values(mcp.secretEnv ?? {}).join(", ") || "No secrets requested"}
            </p>
          </article>
        ))}
        {definition.mcp.length === 0 ? (
          <p className="text-sm">No MCP definitions registered.</p>
        ) : null}
      </section>
    </div>
  );
}
