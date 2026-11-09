import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { randomUUID } from "../../lib/utils";

export function EvaluationsPanel({
  environmentId,
  factoryId,
  runId,
}: {
  environmentId: EnvironmentId;
  factoryId?: string;
  runId?: string;
}) {
  const [selectedRun, setSelectedRun] = useState("");
  const [scorerFactory, setScorerFactory] = useState("");
  const [scorerVersion, setScorerVersion] = useState("");
  const [scorerId, setScorerId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ factoryId: string; id: string }>();
  const [after, setAfter] = useState<string>();
  const history = useAutomationQuery(environmentId, {
    op: "evaluations",
    ...(factoryId ? { factoryId } : {}),
    ...(runId ? { runId } : {}),
    ...(after ? { after } : {}),
  });
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  const items = history.result?.kind === "evaluations" ? history.result.items : [];
  async function evaluate() {
    if (!factoryId || busy) return;
    setBusy(true);
    const response = await command({
      environmentId,
      input: {
        op: "evaluateRun",
        input: {
          id: randomUUID(),
          factoryId,
          runId: runId ?? selectedRun,
          scorerFactoryId: scorerFactory || factoryId,
          scorerVersionId: scorerVersion,
          scorerId,
        },
      },
    });
    setBusy(false);
    setMessage(
      AsyncResult.isSuccess(response)
        ? `Evaluation ${response.value.kind === "evaluationQueued" ? response.value.id : ""} queued. Refresh to see the recorded result. Re-evaluation creates a new history entry.`
        : "Evaluation could not be queued. Check the run is completed and the scorer revision exists.",
    );
    history.refresh();
  }
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2>Evaluations</h2>
        <Button variant="outline" onClick={history.refresh}>
          Refresh evaluations
        </Button>
      </div>
      <p>
        Scores range from 0 to 1. A run passes when every criterion meets its versioned threshold.
        Missing evidence and judge failures remain visible. Model revision records the configured
        identifier; the provider does not expose an immutable backend snapshot.
      </p>
      {factoryId && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void evaluate();
          }}
        >
          <EvaluationSelection
            environmentId={environmentId}
            factoryId={factoryId}
            runId={runId}
            selectedRun={selectedRun}
            onRun={setSelectedRun}
            onScorer={(version, id) => {
              setScorerFactory(factoryId);
              setScorerVersion(version);
              setScorerId(id);
            }}
            scorerId={scorerId}
          />
          <details>
            <summary>Advanced: use another scorer revision</summary>
            <p className="text-sm text-muted-foreground">
              Use this only when you have the exact identifiers of a registered scorer revision.
            </p>
            <label className="block">
              Scorer factory
              <Input
                value={scorerFactory}
                onChange={(event) => setScorerFactory(event.target.value)}
              />
            </label>
            <label className="block">
              Scorer definition version
              <Input
                value={scorerVersion}
                onChange={(event) => setScorerVersion(event.target.value)}
              />
            </label>
            <label className="block">
              Scorer ID
              <Input value={scorerId} onChange={(event) => setScorerId(event.target.value)} />
            </label>
          </details>
          <Button
            type="submit"
            disabled={!allowed || busy || !(runId || selectedRun) || !scorerVersion || !scorerId}
          >
            Evaluate run
          </Button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {history.error && <p role="alert">{history.error}</p>}
      {history.loading ? (
        <p>Loading evaluations…</p>
      ) : items.length === 0 ? (
        <p>
          No recorded evaluations in this scope. Queued evaluations appear after the judge finishes.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <Button
                variant="outline"
                onClick={() => setSelected({ factoryId: item.factoryId, id: item.id })}
              >
                {item.factoryId} / {item.runId} · {item.scorerId} · {item.status}
                {item.passed === null ? "" : item.passed ? " · passed" : " · below threshold"}
              </Button>
              <p>
                {item.recordedAt} · {item.reason ?? "All criteria scored"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
          First page
        </Button>
        <Button
          variant="outline"
          disabled={items.length < 50}
          onClick={() => setAfter(items.at(-1)?.id)}
        >
          Next page
        </Button>
      </div>
      {selected && (
        <EvaluationDetails
          environmentId={environmentId}
          factoryId={selected.factoryId}
          id={selected.id}
        />
      )}
    </section>
  );
}

function EvaluationSelection({
  environmentId,
  factoryId,
  runId,
  selectedRun,
  onRun,
  onScorer,
  scorerId,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string | undefined;
  selectedRun: string;
  onRun: (id: string) => void;
  onScorer: (version: string, id: string) => void;
  scorerId: string;
}) {
  const runs = useAutomationQuery(environmentId, {
    op: "runs",
    factoryId,
    state: "succeeded",
    limit: 50,
  });
  const factory = useAutomationQuery(environmentId, { op: "factory", factoryId });
  const active = factory.result?.kind === "factory" ? factory.result.active : null;
  const scorers = active?.definition.schemaVersion === 4 ? (active.definition.scorers ?? []) : [];
  return (
    <div className="space-y-3">
      {!runId ? (
        <label className="block space-y-1">
          Completed run
          <select
            required
            className="block w-full rounded-md border bg-background p-2"
            value={selectedRun}
            onChange={(event) => onRun(event.target.value)}
          >
            <option value="">Choose a successful run</option>
            {runs.result?.kind === "runs"
              ? runs.result.items.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.workItemTitle ?? run.repository} · {run.id}
                  </option>
                ))
              : null}
          </select>
          <span className="text-xs text-muted-foreground">
            Up to 50 successful runs. Open a run to evaluate it directly.
          </span>
        </label>
      ) : null}
      <label className="block space-y-1">
        Scorer from the active definition
        <select
          className="block w-full rounded-md border bg-background p-2"
          value={scorerId}
          onChange={(event) => onScorer(active?.factoryVersionId ?? "", event.target.value)}
        >
          <option value="">Choose a scorer</option>
          {scorers.map((scorer) => (
            <option key={scorer.id} value={scorer.id}>
              {scorer.name}
            </option>
          ))}
        </select>
      </label>
      {factory.loading || runs.loading ? <p role="status">Loading evaluation choices…</p> : null}
      {factory.error || runs.error ? <p role="alert">{factory.error ?? runs.error}</p> : null}
      {!factory.loading && !factory.error && !scorers.length ? (
        <p className="text-sm text-muted-foreground">
          No scorers in the active definition. Configure a scorer in your definitions repository, or
          select a known revision under Advanced.
        </p>
      ) : null}
    </div>
  );
}

function EvaluationDetails({
  environmentId,
  factoryId,
  id,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  id: string;
}) {
  const detail = useAutomationQuery(environmentId, { op: "evaluation", factoryId, id });
  const result = detail.result?.kind === "evaluation" ? detail.result.result : null;
  return (
    <div>
      {detail.loading && <p>Loading evidence…</p>}
      {detail.error && <p role="alert">{detail.error}</p>}
      {result && (
        <article className="space-y-3">
          <h3>Evaluation {result.input.id}</h3>
          <p>
            Run definition: {result.input.definitionRevision} · Scorer revision:{" "}
            {result.input.scorerRevision}
          </p>
          <p>Run Git revision: {result.input.runRevision}</p>
          <details>
            <summary>Run definition source</summary>
            <pre className="overflow-auto whitespace-pre-wrap">
              {JSON.stringify(result.input.definitionSource, null, 2)}
            </pre>
          </details>
          <details>
            <summary>Scorer definition and source</summary>
            <pre className="overflow-auto whitespace-pre-wrap">{result.input.scorerSource}</pre>
            <pre className="overflow-auto whitespace-pre-wrap">
              {JSON.stringify(result.input.scorer, null, 2)}
            </pre>
          </details>
          <p>
            Judge: {result.input.scorer.judge.model} · Reasoning:{" "}
            {result.input.scorer.judge.reasoningEffort}
          </p>
          <pre className="overflow-auto whitespace-pre-wrap">
            {JSON.stringify(result.input.modelConfiguration, null, 2)}
          </pre>
          {result.judgment?.criteria.map((criterion) => (
            <div key={criterion.id}>
              <h4>
                {criterion.id}: {criterion.score} / threshold{" "}
                {result.input.scorer.criteria.find((item) => item.id === criterion.id)?.threshold}
              </h4>
              <p>{criterion.rationale}</p>
              <p>Evidence: {criterion.evidenceIds.join(", ")}</p>
            </div>
          ))}
          {result.input.evidence.map((evidence) => (
            <details key={evidence.id}>
              <summary>
                {evidence.source} · {evidence.sha256}
              </summary>
              <pre className="overflow-auto whitespace-pre-wrap">{evidence.content}</pre>
            </details>
          ))}
        </article>
      )}
    </div>
  );
}
