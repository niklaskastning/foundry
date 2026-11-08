import { useEffect, useRef } from "react";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import type { AutomationApplicationResult, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAutomationQuery } from "./useAutomationQuery";
import { runReasonLabel, runScopeLabel, runStatusVariant } from "./runTopology";

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
  const groups = new Map<string, NonNullable<typeof state>["nodes"][number][]>();
  for (const node of state?.nodes ?? []) {
    const group = groups.get(node.scope);
    if (group) group.push(node);
    else groups.set(node.scope, [node]);
  }
  const offset = Number(navigation.search.nodeOffset ?? 0);
  return (
    <section className="min-w-0 space-y-3" aria-label="Workflow iterations and branches">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-lg font-semibold">Workflow progress</h3>
        <p className="text-xs text-muted-foreground">
          {state?.startedAgentExecutions ?? 0} / {workflow.limits.maxAgentExecutions} agent and test
          starts · Up to {workflow.limits.maxConcurrentAgents} concurrent
        </p>
      </div>
      {state?.reason ? (
        <p role="status" className="text-sm">
          {runReasonLabel(state.reason)}
        </p>
      ) : null}
      {selected ? (
        <NodeResult
          key={selected}
          environmentId={environmentId}
          factoryId={factoryId}
          runId={runId}
          path={selected}
          onClose={() => navigation.update({ nodePath: undefined })}
        />
      ) : null}
      {!state ? (
        <p className="text-sm text-muted-foreground">Execution has not been initialized.</p>
      ) : (
        <>
          <div className="divide-y border-y">
            {[...groups].map(([scope, nodes]) => (
              <section key={scope} className="min-w-0 py-3" aria-label={runScopeLabel(scope)}>
                <h4 className="mb-2 break-words text-xs font-medium text-muted-foreground">
                  {runScopeLabel(scope)}
                </h4>
                <ol className="divide-y">
                  {nodes.map((node) => (
                    <li
                      key={node.path}
                      id={`run-step-${encodeURIComponent(node.path)}`}
                      className="min-w-0 scroll-mt-16 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="break-words font-medium">{node.definition.id}</span>
                            <Badge variant={runStatusVariant(node.status)}>{node.status}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {node.definition.kind === "loop"
                                ? "Review / fix loop"
                                : node.definition.kind === "swarm"
                                  ? "Parallel branches"
                                  : node.definition.kind}
                            </span>
                          </div>
                          {node.iteration !== undefined ? (
                            <p className="text-xs text-muted-foreground">
                              Review round {node.iteration}
                              {node.until === true
                                ? " · Stop condition met"
                                : node.until === false
                                  ? " · Stop condition not met"
                                  : ""}
                            </p>
                          ) : null}
                          {node.reason ? (
                            <p className="text-sm text-muted-foreground">
                              {runReasonLabel(node.reason)}
                            </p>
                          ) : null}
                          {node.condition === false ? (
                            <p className="text-xs text-muted-foreground">
                              Condition not met; this step was skipped.
                            </p>
                          ) : null}
                          {node.cancelRequested && node.status === "running" ? (
                            <p className="text-xs text-muted-foreground">
                              Stop requested; waiting for confirmed writer shutdown.
                            </p>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          aria-expanded={selected === node.path}
                          onClick={() =>
                            navigation.update({
                              nodePath: selected === node.path ? undefined : node.path,
                            })
                          }
                        >
                          {selected === node.path ? "Close node result" : "Inspect result"}
                        </Button>
                      </div>
                      {node.definition.kind === "approval" &&
                      (node.status === "ready" ||
                        node.status === "waiting" ||
                        node.status === "running") ? (
                        <Link
                          className="text-sm underline"
                          to="/foundry"
                          search={{ view: "inbox", factoryId, inboxKind: "approval" }}
                        >
                          Review decision in Inbox
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              {state.nodes.length} of {state.nodesTotal} nodes · Page {Math.floor(offset / 100) + 1}
            </p>
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => onPage(Math.max(0, offset - 100))}
            >
              Previous nodes
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
  onClose,
  ...input
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  path: string;
  onClose: () => void;
}) {
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "runtimeNode",
    ...input,
  });
  const node = result?.kind === "runtimeNode" ? result.node : null;
  const heading = useRef<HTMLHeadingElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Move keyboard focus to the explicitly opened node result after URL navigation.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border bg-muted/20 p-4 text-sm"
      aria-label="Node result"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4
          ref={heading}
          tabIndex={-1}
          className="break-words font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          Result · {input.path.split("/").at(-1)}
        </h4>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={refresh}>
            Refresh result
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close result
          </Button>
        </div>
      </div>
      {loading ? <p role="status">Loading pinned node data…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {node ? (
        <>
          {node.output === undefined ? (
            <p className="text-muted-foreground">No successful structured output recorded.</p>
          ) : (
            <NodeOutput value={node.output} />
          )}
          {node.checkpoint ? (
            <p className="break-all">
              Verified checkpoint <code>{node.checkpoint.commitSha}</code>
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              Inputs, carried values & provenance
            </summary>
            <dl className="space-y-2 pt-3">
              <div>
                <dt>Node path</dt>
                <dd className="break-all">{input.path}</dd>
              </div>
              <div>
                <dt>Workspace basis</dt>
                <dd className="break-all">{node.base}</dd>
              </div>
              {node.checkpoint ? (
                <div>
                  <dt>Checkpoint execution / worker</dt>
                  <dd className="break-all">
                    {node.checkpoint.commandId} · {node.checkpoint.workerId}
                  </dd>
                </div>
              ) : null}
              {node.inputs ? (
                <div>
                  <dt>Inputs</dt>
                  <dd>
                    <pre className="max-h-64 overflow-auto text-xs">
                      {JSON.stringify(node.inputs, null, 2)}
                    </pre>
                  </dd>
                </div>
              ) : null}
              {node.carry ? (
                <div>
                  <dt>Carried values</dt>
                  <dd>
                    <pre className="max-h-64 overflow-auto text-xs">
                      {JSON.stringify(node.carry, null, 2)}
                    </pre>
                  </dd>
                </div>
              ) : null}
            </dl>
          </details>
        </>
      ) : null}
    </section>
  );
}

function NodeOutput({
  value,
}: {
  value: NonNullable<
    Extract<AutomationApplicationResult, { kind: "runtimeNode" }>["node"]["output"]
  > | null;
}) {
  const fields =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).filter(([, item]) => item === null || typeof item !== "object")
      : [];
  return (
    <div className="space-y-3">
      {fields.length ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          {fields.map(([key, item]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{key.replaceAll("_", " ")}</dt>
              <dd className="whitespace-pre-wrap break-words">{String(item)}</dd>
            </div>
          ))}
        </dl>
      ) : value === null || typeof value !== "object" ? (
        <p className="whitespace-pre-wrap break-words">{String(value)}</p>
      ) : (
        <p className="text-muted-foreground">
          Structured result recorded. Open the data to inspect its fields.
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Structured result data
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words pt-2 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
    </div>
  );
}
