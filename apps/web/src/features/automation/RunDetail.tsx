import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AutomationControlCommand,
  EnvironmentId,
  FoundryArtifactManifest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Link } from "@tanstack/react-router";
import { useWorkspaceNavigation } from "../../foundry/useWorkspaceNavigation";
import { AttachmentFilePreview } from "../../components/files/AttachmentFilePreview";
import { Button } from "../../components/ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { HandoffList, TakeOverPanel } from "./HandoffPanel";
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
  const navigation = useWorkspaceNavigation();
  const after = navigation.search.attemptsAfter;
  const setAfter = (attemptsAfter?: string) =>
    navigation.update({ attemptsAfter, attemptId: undefined });
  const attempts = useAutomationQuery(environmentId, {
    op: "attempts",
    factoryId,
    runId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const selected = navigation.search.attemptId;
  const setSelected = (attemptId: string) => navigation.update({ attemptId });
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
      <div className="space-y-1">
        <Link
          className="text-sm text-muted-foreground underline"
          to="/foundry"
          search={{ view: "factories", factoryId, tab: "overview" }}
        >
          {detail?.factoryName ?? "Factory workspace"}
        </Link>
        <h2 className="text-xl font-semibold">{detail?.workItem?.title ?? "Workflow run"}</h2>
        {detail ? (
          <Link
            className="text-sm underline"
            to="/foundry"
            search={{
              view: "factories",
              factoryId,
              workItemId: detail.run.workItemId,
              tab: "work",
            }}
          >
            Open work item and handoffs
          </Link>
        ) : null}
      </div>
      {run.error || attempts.error ? <p role="alert">{run.error ?? attempts.error}</p> : null}
      {detail ? (
        <>
          <p className="text-sm">
            {detail.control?.state ?? detail.run.state}
            {detail.control?.reason ? ` · ${detail.control.reason}` : ""}
          </p>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              Run identity, revisions and pinned source
            </summary>
            <dl className="grid gap-1 pt-3 text-sm">
              <div>Run: {runId}</div>
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
            <section
              aria-label="Pinned definition origin"
              className="space-y-1 rounded border p-3 text-sm"
            >
              <h3 className="font-medium">Pinned definition origin</h3>
              {detail.definition ? (
                <>
                  <p>Definition version: {detail.definition.id}</p>
                  <p className="break-all">Content hash: {detail.definition.contentHash}</p>
                  {detail.definition.source.kind === "github" ? (
                    <>
                      <p>
                        {detail.definition.source.repository} · {detail.definition.source.branch} ·{" "}
                        {detail.definition.source.path || "/"}
                      </p>
                      <a
                        className="break-all underline"
                        target="_blank"
                        rel="noreferrer"
                        href={`https://github.com/${detail.definition.source.repository}/commit/${detail.definition.source.commitSha}`}
                      >
                        {detail.definition.source.commitSha}
                      </a>
                    </>
                  ) : (
                    <p>
                      Local source: {detail.definition.source.kind} ·{" "}
                      {detail.definition.source.reference}
                    </p>
                  )}
                </>
              ) : (
                <p>No definition provenance is available for this run.</p>
              )}
            </section>
          </details>
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
          {detail.control?.state === "waiting" || detail.control?.reason ? (
            <Link className="text-sm underline" to="/foundry" search={{ view: "inbox", factoryId }}>
              Review questions, decisions and blockers in Inbox
            </Link>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <h3 className="font-medium">Steps and results</h3>
      {detail && attempts.result?.kind === "attempts" ? (
        <>
          <ol className="space-y-3">
            {detail.workflow.steps.map((step, ordinal) => (
              <li key={step.id} className="space-y-3 rounded-lg border p-4">
                <h4 className="font-medium">
                  {ordinal + 1}. {step.id} ·{" "}
                  {step.kind === "agent" ? (step.resolved?.role?.name ?? "Agent") : step.kind}
                </h4>
                {step.kind === "agent" || step.kind === "approval" ? (
                  <p className="whitespace-pre-wrap text-sm">{step.prompt}</p>
                ) : null}
                {step.kind === "agent" && step.resolved ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer">Pinned agent configuration</summary>
                    <div className="space-y-2 pt-2">
                      <p>
                        Codex ·{" "}
                        {step.resolved.execution.model ??
                          detail.executionBinding?.model ??
                          "Run binding model"}{" "}
                        ·{" "}
                        {step.resolved.execution.options?.reasoningEffort ??
                          "Provider reasoning default"}
                      </p>
                      <p>
                        Skills:{" "}
                        {step.resolved.skills.map((skill) => skill.name).join(", ") || "None"}
                      </p>
                      <p className="whitespace-pre-wrap">{step.resolved.instructions}</p>
                    </div>
                  </details>
                ) : null}
                {attempts.result?.kind === "attempts" &&
                  attempts.result.items
                    .filter((attempt) => attempt.ordinal === ordinal)
                    .map((attempt) => (
                      <div key={attempt.commandId} className="space-y-2 border-t pt-3">
                        <p className="text-sm">
                          Attempt {attempt.attemptNumber + 1} · {attempt.state.replaceAll("_", " ")}
                          {attempt.reason ? ` · ${attempt.reason.replaceAll("_", " ")}` : ""}
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
                          <Button variant="outline" onClick={() => setSelected(attempt.commandId)}>
                            {attempt.hasResult ? "Inspect result & evidence" : "Inspect execution"}
                          </Button>
                        </div>
                        {!attempt.hasResult ? (
                          <p className="text-xs text-muted-foreground">
                            {step.kind === "approval"
                              ? "This step records a human decision without a provider turn."
                              : "No confirmed final result yet. Completion also requires writer shutdown and complete archival."}
                          </p>
                        ) : null}
                      </div>
                    ))}
                {attempts.result?.kind === "attempts" &&
                !attempts.result.items.some((attempt) => attempt.ordinal === ordinal) ? (
                  step.kind === "approval" ? (
                    <div className="space-y-1 text-sm">
                      <p>This step requires a revision-bound human decision.</p>
                      <Link
                        className="underline"
                        to="/foundry"
                        search={{ view: "inbox", factoryId, inboxKind: "approval" }}
                      >
                        Review the current decision and evidence in Inbox
                      </Link>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No attempt on this page.</p>
                  )
                ) : null}
              </li>
            ))}
          </ol>
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
      {detail ? (
        <>
          <TakeOverPanel
            environmentId={environmentId}
            factoryId={factoryId}
            runId={runId}
            control={detail.control}
            attempts={attempts.result?.kind === "attempts" ? attempts.result.items : []}
            refresh={() => {
              run.refresh();
              attempts.refresh();
            }}
          />
          <HandoffList
            environmentId={environmentId}
            factoryId={factoryId}
            workItemId={detail.run.workItemId}
          />
        </>
      ) : null}
    </section>
  );
}
export function AttemptResult({
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
  const [selectedArtifact, setSelectedArtifact] = useState<FoundryArtifactManifest | null>(null);
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
          {result.launch ? (
            <details>
              <summary className="cursor-pointer text-sm">
                Actual worker launch configuration
              </summary>
              <div className="space-y-2 pt-2 text-sm">
                <p>
                  Model: {result.launch.model} · Reasoning:{" "}
                  {result.launch.options?.reasoningEffort ?? "Provider default"}
                </p>
                <p className="whitespace-pre-wrap">{result.launch.prompt}</p>
              </div>
            </details>
          ) : null}
          {result.publish ? (
            <p className="text-sm">
              <a className="underline" href={result.publish.url} target="_blank" rel="noreferrer">
                Pull request #{result.publish.number}
              </a>{" "}
              · Commit {result.publish.commitSha}
            </p>
          ) : null}
          {result.execution?.lifecycle?.manifest?.publishEvidence ? (
            <div className="space-y-1 text-sm">
              <p>
                Verified publish commit:{" "}
                {result.execution.lifecycle.manifest.publishEvidence.commitSha}
              </p>
              <p>
                Repository: {result.execution.lifecycle.manifest.publishEvidence.repository} · Base:{" "}
                {result.execution.lifecycle.manifest.publishEvidence.baseBranch}
              </p>
              <p>
                Confirmed checks:{" "}
                {result.execution.lifecycle.manifest.publishEvidence.checks.length}
              </p>
              <ul className="space-y-1">
                {result.execution.lifecycle.manifest.publishEvidence.checks.map((check) => (
                  <li key={check.id}>
                    {check.id} · exit {check.exitCode} · <code>{check.command}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
          {result.execution?.lifecycle?.manifest?.archive ? (
            <a
              className="text-sm underline"
              href={`/${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.environmentId)}/${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.threadId)}?factoryId=${encodeURIComponent(factoryId)}&runId=${encodeURIComponent(runId)}`}
            >
              Open T3 thread to review changes
            </a>
          ) : null}
          <ul>
            {result.artifacts.map((artifact) => (
              <li key={artifact.reference.artifactId} className="text-sm">
                {artifact.name} · {artifact.sizeBytes} bytes ·{" "}
                <Button variant="outline" onClick={() => setSelectedArtifact(artifact)}>
                  Open artifact
                </Button>
              </li>
            ))}
          </ul>
          {selectedArtifact ? (
            <div
              className="flex h-96 flex-col overflow-hidden rounded-lg border"
              key={selectedArtifact.reference.artifactId}
            >
              <AttachmentFilePreview
                name={selectedArtifact.name}
                mimeType={selectedArtifact.mimeType}
                sizeBytes={selectedArtifact.sizeBytes}
                asset={{
                  environmentId: selectedArtifact.reference.owner.environmentId,
                  attachmentId: selectedArtifact.reference.artifactId,
                  foundryArtifact: selectedArtifact,
                }}
                onClose={() => setSelectedArtifact(null)}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
