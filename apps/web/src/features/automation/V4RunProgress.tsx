import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import type { AutomationApplicationResult, EnvironmentId } from "@t3tools/contracts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAutomationQuery } from "./useAutomationQuery";

type RunDetail = Extract<AutomationApplicationResult, { kind: "run" }>;
export function V4RunProgress({
  state,
  workflow,
  environmentId,
  factoryId,
  runId,
  onPage,
}: {
  state: RunDetail["runtimeState"];
  workflow: NonNullable<RunDetail["runtimeWorkflow"]>;
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  onPage: (offset: number) => void;
}) {
  const navigation = useWorkspaceNavigation();
  const selected = navigation.search.nodePath;
  const setSelected = (nodePath: string | undefined) => navigation.update({ nodePath });
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-label="Workflow iterations and branches"
    >
      <h3 className="font-semibold">Iterations, branches & conditions</h3>
      <p className="text-sm">
        {state?.startedAgentExecutions ?? 0} / {workflow.limits.maxAgentExecutions} agent and test
        starts · At most {workflow.limits.maxConcurrentAgents} concurrent executions
      </p>
      {state?.reason ? (
        <p role="status" className="text-sm">
          {state.reason.replaceAll("_", " ")}
        </p>
      ) : null}
      {!state ? (
        <p className="text-sm">Execution has not been initialized.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {state.nodesTotal} nodes across all iterations. This page shows {state.nodes.length}.
          </p>
          <ol className="space-y-3">
            {state.nodes.map((node) => (
              <li key={node.path} className="space-y-2 border-l-2 pl-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium">{node.path}</span>
                  <Badge
                    variant={
                      node.status === "succeeded"
                        ? "success"
                        : node.status === "failed" || node.status === "blocked"
                          ? "error"
                          : "outline"
                    }
                  >
                    {node.status}
                  </Badge>
                </div>
                <p>
                  {node.definition.kind}
                  {node.iteration !== undefined ? ` · Iteration ${node.iteration}` : ""}
                  {node.reason ? ` · ${node.reason.replaceAll("_", " ")}` : ""}
                </p>
                {node.condition !== undefined ? (
                  <p>Saved condition: {String(node.condition)}</p>
                ) : null}
                {node.until !== undefined ? (
                  <p>Saved loop stop condition: {String(node.until)}</p>
                ) : null}
                {node.cancelRequested ? (
                  <p>Cancellation requested; waiting for confirmed writer shutdown.</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  {node.ordinal !== undefined ? (
                    <a className="underline" href={`#run-step-${encodeURIComponent(node.path)}`}>
                      Open execution and attempts
                    </a>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => setSelected(selected === node.path ? undefined : node.path)}
                  >
                    {selected === node.path ? "Close node result" : "Inspect inputs and result"}
                  </Button>
                </div>
                {selected === node.path ? (
                  <NodeResult
                    environmentId={environmentId}
                    factoryId={factoryId}
                    runId={runId}
                    path={node.path}
                  />
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onPage(0)}>
              First nodes
            </Button>
            <Button
              variant="outline"
              disabled={state.nextNodeOffset === null}
              onClick={() => {
                if (state.nextNodeOffset !== null) onPage(state.nextNodeOffset);
              }}
            >
              Next nodes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function NodeResult({
  environmentId,
  ...input
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  path: string;
}) {
  const { result, error, loading } = useAutomationQuery(environmentId, {
    op: "runtimeNode",
    ...input,
  });
  const node = result?.kind === "runtimeNode" ? result.node : null;
  return (
    <section className="space-y-2 text-sm" aria-label="Node result">
      {loading ? <p role="status">Loading pinned node data…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {node ? (
        <dl className="space-y-2">
          <div>
            <dt>Workspace basis</dt>
            <dd className="break-all">{node.base}</dd>
          </div>
          {node.checkpoint ? (
            <div>
              <dt>Verified checkpoint</dt>
              <dd className="break-all">
                {node.checkpoint.commitSha} · {node.checkpoint.commandId}
              </dd>
            </div>
          ) : null}
          {node.inputs ? (
            <div>
              <dt>Inputs</dt>
              <dd>
                <pre className="max-h-64 overflow-auto">{JSON.stringify(node.inputs, null, 2)}</pre>
              </dd>
            </div>
          ) : null}
          {node.carry ? (
            <div>
              <dt>Carry</dt>
              <dd>
                <pre className="max-h-64 overflow-auto">{JSON.stringify(node.carry, null, 2)}</pre>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Validated output</dt>
            <dd>
              {node.output === undefined ? (
                "No successful structured output"
              ) : (
                <pre className="max-h-64 overflow-auto">{JSON.stringify(node.output, null, 2)}</pre>
              )}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
