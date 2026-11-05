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
    <div className="space-y-3 text-sm">
      <p>
        {agent.agent.name} · Codex · {agent.execution.model ?? "Worker binding default"} ·{" "}
        {agent.execution.options?.reasoningEffort ?? "Provider reasoning default"}
      </p>
      <dl className="space-y-2">
        <div>
          <dt>Skills</dt>
          <dd>
            {agent.provenance.skills
              .map((resource) => `${resource.id} (${resource.sources.join(" → ")})`)
              .join(", ") || "None"}
          </dd>
        </div>
        <div>
          <dt>MCP</dt>
          <dd>
            {agent.provenance.mcp
              .map((resource) => `${resource.id} (${resource.sources.join(" → ")})`)
              .join(", ") || "None"}
          </dd>
        </div>
        <div>
          <dt>Execution sources</dt>
          <dd>
            Provider: {agent.provenance.execution.provider} · Model:{" "}
            {agent.provenance.execution.model ?? "Worker binding"} · Reasoning:{" "}
            {agent.provenance.execution.reasoningEffort ?? "Provider default"}
          </dd>
        </div>
      </dl>
      <details>
        <summary className="cursor-pointer">Instructions and their origins</summary>
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
    <ol className="space-y-3">
      {nodes.map((node) => (
        <li key={node.id} className="space-y-2 border-l-2 pl-3">
          <p className="font-medium">
            {node.id} · {node.kind}
          </p>
          <p className="text-xs text-muted-foreground">
            Dependencies: {node.dependsOn.join(", ") || "None"} ·{" "}
            {node.dependencyPolicy ?? "Successful predecessors"}
          </p>
          {node.when ? (
            <details>
              <summary className="cursor-pointer text-sm">Condition</summary>
              <pre className="overflow-auto text-xs">{JSON.stringify(node.when, null, 2)}</pre>
            </details>
          ) : null}
          {node.kind === "agent" ? (
            <V4AgentConfiguration agent={resolveFactoryV4Agent(snapshot, node)} />
          ) : null}
          {node.kind === "swarm" ? (
            <p className="text-sm">
              Up to {node.maxParallel} concurrent agents in this subtree · Join: {node.join.policy}
              {node.join.policy === "quorum" ? ` (${node.join.minSuccesses} successes)` : ""} ·{" "}
              {node.join.onFailure.replaceAll("_", " ")}
            </p>
          ) : null}
          {node.kind === "loop" ? (
            <>
              <p className="text-sm">
                At most {node.maxIterations} iterations · On exhaustion: {node.onExhausted}
              </p>
              <details>
                <summary className="cursor-pointer text-sm">
                  Stop condition and carried values
                </summary>
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
      <p className="text-sm">
        Run limit: {workflow.limits.maxConcurrentAgents} concurrent agents ·{" "}
        {workflow.limits.maxAgentExecutions} total starts including technical retries
      </p>
      <WorkflowNodes nodes={workflow.steps} snapshot={{ ...definition, workflow }} />
    </div>
  );
}

export function V4Catalog({ definition }: { definition: CanonicalFactoryDefinitionV4 }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-label="Versioned agents">
        <h3 className="font-medium">Agents</h3>
        {definition.agents.map((agent) => (
          <article key={agent.id} className="space-y-2 rounded-lg border p-4">
            <h4 className="font-medium">{agent.name}</h4>
            <p className="text-sm">{agent.description}</p>
            <p className="text-sm">
              Skills: {agent.skills.join(", ") || "None"} · MCP: {agent.mcp.join(", ") || "None"}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                Base instructions · agents/{agent.id}.yaml
              </summary>
              <p className="whitespace-pre-wrap pt-2 text-sm">{agent.instructions}</p>
            </details>
          </article>
        ))}
      </section>
      <section className="space-y-3" aria-label="Versioned skill bundles">
        <h3 className="font-medium">Skill bundles</h3>
        {definition.skills.map((skill) => (
          <details key={skill.id} className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              {skill.name} · {skill.files.length} files
            </summary>
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
          <article key={mcp.id} className="space-y-2 rounded-lg border p-3 text-sm">
            <h4 className="font-medium">
              {mcp.name} · {mcp.transport}
            </h4>
            <p>mcp/{mcp.id}.yaml</p>
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
