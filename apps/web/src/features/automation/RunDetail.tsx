import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { AutomationControlCommand, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";

export function RunDetail({
  environmentId,
  factoryId,
  runId,
  onBack,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  onBack: () => void;
}) {
  const run = useAutomationQuery(environmentId, { op: "run", factoryId, runId });
  const [after, setAfter] = useState<string>();
  const attempts = useAutomationQuery(environmentId, {
    op: "attempts",
    factoryId,
    runId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<AutomationControlCommand | null>(null);
  const command = useAtomCommand(automationCommands.control, { reportFailure: false });
  const canControl = useAtomValue(automationCommands.control.permissionAtom(environmentId));
  const detail = run.result?.kind === "run" ? run.result : null;
  const state = detail?.control?.state;
  const terminal = state === "succeeded" || state === "cancelled";
  const available = {
    pause: !terminal && state !== "paused" && state !== "failed" && state !== "cancel_requested",
    resume: state === "paused" || state === "waiting",
    cancel: !terminal,
    retry: state === "failed",
  };
  async function act(action: "pause" | "resume" | "cancel" | "retry") {
    if (busy || !detail?.control) return;
    const input =
      pending?.action === action
        ? pending
        : {
            commandId: randomUUID(),
            factoryId,
            runId,
            expectedRevision: detail.control.revision,
            action,
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
    if (
      AsyncResult.isFailure(response) &&
      isDefinitiveAutomationFailure(squashAtomCommandFailure(response))
    ) {
      run.refresh();
      attempts.refresh();
    }
    if (AsyncResult.isSuccess(response)) {
      setPending(null);
      setMessage("Run decision saved.");
      run.refresh();
      attempts.refresh();
    } else
      setMessage(
        "The decision could not be saved. Refresh to check the current revision; unconfirmed requests retain their command ID.",
      );
  }
  return (
    <section className="space-y-4" aria-label="Run detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back to runs
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            run.refresh();
            attempts.refresh();
          }}
        >
          Refresh progress
        </Button>
      </div>
      <h2 className="text-lg font-medium">Run {runId}</h2>
      {run.error || attempts.error ? <p role="alert">{run.error ?? attempts.error}</p> : null}
      {detail ? (
        <>
          <p className="text-sm">
            {detail.control?.state ?? detail.run.state}
            {detail.control?.reason ? ` · ${detail.control.reason}` : ""}
          </p>
          <dl className="grid gap-1 text-sm">
            <div>Work item: {detail.run.workItemId}</div>
            <div>Input revision: {detail.run.revision}</div>
            <div>Factory version: {detail.run.factoryVersionId}</div>
            <div>Workflow version: {detail.run.workflowVersionId}</div>
            {detail.control ? (
              <div>
                Decision revision {detail.control.revision} · Result revision{" "}
                {detail.control.resultRevision}
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-2">
            {(["pause", "resume", "cancel", "retry"] as const).map((action) => (
              <Button
                key={action}
                variant={action === "cancel" ? "destructive" : "outline"}
                disabled={busy || !canControl || !detail.control || !available[action]}
                onClick={() => void act(action)}
              >
                {action.charAt(0).toUpperCase() + action.slice(1)}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Pause prevents new steps while accepted work can finish. Cancel requests a stop;
            confirmation waits for the writer to end. Retry creates a new attempt only when safe.
          </p>
          <ol className="list-inside list-decimal space-y-1 text-sm">
            {detail.workflow.steps.map((step) => (
              <li key={step.id}>
                {step.id} · {step.kind}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <h3 className="font-medium">Step attempts</h3>
      {attempts.result?.kind === "attempts" ? (
        <>
          <ul className="divide-y rounded-lg border">
            {attempts.result.items.map((attempt) => (
              <li key={attempt.commandId} className="space-y-2 p-3">
                <p className="text-sm">
                  Step {attempt.ordinal + 1} · Attempt {attempt.attemptNumber + 1} · {attempt.state}
                  {attempt.reason ? ` · ${attempt.reason}` : ""}
                </p>
                <div className="flex flex-wrap gap-3 text-sm">
                  {attempt.threadId && attempt.environmentId ? (
                    <>
                      <a
                        className="underline"
                        href={`/${encodeURIComponent(attempt.environmentId)}/${encodeURIComponent(attempt.threadId)}?factoryId=${encodeURIComponent(factoryId)}&runId=${encodeURIComponent(runId)}`}
                      >
                        Open T3 thread
                      </a>
                      <a
                        className="underline"
                        href={`/foundry?archiveEnvironmentId=${encodeURIComponent(attempt.environmentId)}&archiveThreadId=${encodeURIComponent(attempt.threadId)}`}
                      >
                        Read central archive
                      </a>
                    </>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={!attempt.hasResult}
                    onClick={() => setSelected(attempt.commandId)}
                  >
                    Load result
                  </Button>
                </div>
                {!attempt.hasResult ? (
                  <p className="text-xs text-muted-foreground">
                    {detail?.workflow.steps[attempt.ordinal]?.kind === "approval"
                      ? "Human decision recorded; this step does not execute a provider turn."
                      : "No confirmed final result. A running or completed turn alone does not prove writer shutdown or complete archival."}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
              First attempts
            </Button>
            <Button
              variant="outline"
              disabled={!attempts.result.next}
              onClick={() =>
                setAfter(
                  attempts.result?.kind === "attempts"
                    ? (attempts.result.next ?? undefined)
                    : undefined,
                )
              }
            >
              Next attempts
            </Button>
          </div>
        </>
      ) : null}
      {selected ? (
        <AttemptResult
          key={selected}
          environmentId={environmentId}
          factoryId={factoryId}
          runId={runId}
          commandId={selected}
        />
      ) : null}
    </section>
  );
}
function AttemptResult({
  environmentId,
  factoryId,
  runId,
  commandId,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  commandId: string;
}) {
  const { result, error, loading } = useAutomationQuery(environmentId, {
    op: "attempt",
    factoryId,
    runId,
    commandId,
  });
  return (
    <section className="space-y-2 rounded border p-3" aria-label="Attempt result">
      {loading ? <p role="status">Loading result…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result?.kind === "attempt" ? (
        <>
          <p className="text-sm">Worker run: {result.execution?.run.status ?? "No final result"}</p>
          <p className="text-sm">
            Checkpoint: {result.execution?.run.checkpointId ?? "Unconfirmed"}
          </p>
          <p className="text-sm">
            Writer end: {result.execution?.lifecycle?.writerEnded ? "Confirmed" : "Unconfirmed"}
          </p>
          <p className="text-sm">
            Archive:{" "}
            {result.execution?.lifecycle?.manifest?.archive
              ? `Confirmed through event ${result.execution.lifecycle.manifest.archive.cursor} (source ${result.execution.lifecycle.manifest.archive.sourceSequence})`
              : "No final archive confirmation"}
          </p>
          <p className="text-xs text-muted-foreground">
            The central archive reports its own sequence completeness. Missing events or blobs
            remain incomplete.
          </p>
          <ul>
            {result.artifacts.map((artifact) => (
              <li key={artifact.reference.artifactId} className="text-sm">
                {artifact.name} · {artifact.sizeBytes} bytes ·{" "}
                <a className="underline" href="/foundry">
                  Open central files
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
