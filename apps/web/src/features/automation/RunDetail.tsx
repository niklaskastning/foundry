import { FoundryUI } from "../../foundry/FoundryUI";
import { EvaluationsPanel } from "./EvaluationsPanel";
import { OperationsDashboardPanel } from "./OperationsDashboardPanel";
import { SandboxRunStatus } from "../../components/foundry/SandboxRunStatus";
import { V4AgentConfiguration } from "./V4Configuration";
import { V4RunProgress } from "./V4RunProgress";
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
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { HandoffList, TakeOverPanel } from "./HandoffPanel";
import { useAutomationQuery } from "./useAutomationQuery";
import {
  runReasonLabel,
  runExecutionStep,
  runScopeLabel,
  runStatusVariant,
  runTopology,
} from "./runTopology";

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
  const navigation = useWorkspaceNavigation();
  const offset = Number(navigation.search.nodeOffset ?? "0");
  const nodesAfter = Number.isInteger(offset) && offset >= 0 && offset <= 20000 ? offset : 0;
  const setNodesAfter = (value: number) =>
    navigation.update({ nodeOffset: String(value), nodePath: undefined });
  const run = useAutomationQuery(environmentId, { op: "run", factoryId, runId, nodesAfter });
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
  const setSelected = (attemptId?: string) => navigation.update({ attemptId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<AutomationControlCommand | null>(null);
  const command = useAtomCommand(automationCommands.control, { reportFailure: false });
  const canControl = useAtomValue(automationCommands.control.permissionAtom(environmentId));
  const detail = run.result?.kind === "run" ? run.result : null;
  const topology = detail ? runTopology(detail.workflow) : null;
  const execution = detail?.workflow.execution;
  const state = detail?.control?.state ?? detail?.run.state;
  const latestReport =
    attempts.result?.kind === "attempts"
      ? attempts.result.items
          .filter((attempt) => attempt.hasResult)
          .toSorted(
            (left, right) =>
              right.ordinal - left.ordinal || right.attemptNumber - left.attemptNumber,
          )[0]
      : undefined;
  const terminal = state === "succeeded" || state === "cancelled";
  const available = {
    pause: !terminal && state !== "paused" && state !== "failed" && state !== "cancel_requested",
    resume: state === "paused" || state === "waiting",
    cancel: !terminal,
    retry: state === "failed" && !detail?.runtimeWorkflow,
  };
  async function act(action: "pause" | "resume" | "cancel" | "retry") {
    if (busy || !detail?.control) return;
    if (
      action === "cancel" &&
      pending?.action !== "cancel" &&
      !window.confirm(
        "Request cancellation of this run? Work stops after the active writer confirms shutdown.",
      )
    )
      return;
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
    <section className="min-w-0 space-y-4 wrap-anywhere" aria-label="Run detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          {navigation.search.workItemId ? "Back to work item" : "Back to runs"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            run.refresh();
            attempts.refresh();
          }}
        >
          Refresh run and execution history
        </Button>
      </div>
      <div className="space-y-2 border-b pb-5">
        <Link
          className="text-sm text-muted-foreground underline"
          to="/foundry"
          search={{ view: "factories", factoryId, tab: "overview" }}
        >
          {detail?.factoryName ?? "Factory workspace"}
        </Link>
        <FoundryUI.Heading className="text-xl font-semibold">
          {detail?.workItem?.title ?? "Workflow run"}
        </FoundryUI.Heading>
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
      {run.loading && !detail ? <p role="status">Loading run…</p> : null}
      {run.error || attempts.error ? (
        <FoundryUI.Notice>{run.error ?? attempts.error}</FoundryUI.Notice>
      ) : null}
      {detail?.executionBinding?.sandbox ? (
        <SandboxRunStatus
          environmentId={environmentId}
          factoryId={factoryId}
          runId={runId}
          target={detail.executionBinding.sandbox}
        />
      ) : null}
      {detail ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-5 rounded-xl border bg-card p-4 shadow-xs sm:p-6">
            <div className="space-y-2">
              <Badge
                size="lg"
                variant={
                  state === "succeeded"
                    ? "success"
                    : state === "failed"
                      ? "error"
                      : state === "waiting" || state === "paused"
                        ? "warning"
                        : "secondary"
                }
              >
                {(state ?? detail.run.state).replaceAll("_", " ")}
              </Badge>
              <p className="text-sm">
                {(detail.control?.reason === "repair_pending"
                  ? "A failed branch is queued for a bounded repair attempt. The join waits for successful branch results."
                  : detail.control?.reason === "repair_exhausted"
                    ? "Automatic repair rounds are exhausted. Inspect failed attempts before deciding how to continue."
                    : (detail.control?.reason ?? detail.runtimeState?.reason)
                      ? runReasonLabel(detail.control?.reason ?? detail.runtimeState?.reason ?? "")
                      : undefined) ??
                  (state === "succeeded"
                    ? "Execution completed. Review the step results below."
                    : state === "failed"
                      ? detail.runtimeWorkflow
                        ? "Execution failed. Inspect the result and exhausted budgets. A new run requires an explicit start."
                        : "Execution failed. Inspect the failed attempt before retrying."
                      : state === "paused"
                        ? "Run control has paused scheduling. Resume allows the scheduler to continue pending work; completed steps alone do not confirm run completion. Review the workflow and decisions before resuming."
                        : state === "waiting"
                          ? "Execution is waiting. Review the current decisions and blockers."
                          : state === "cancel_requested"
                            ? "Stop requested. Waiting for writer shutdown confirmation."
                            : state === "cancelled"
                              ? "Execution was cancelled. Review completed results below; cancellation does not close the work item or imply that every step failed."
                              : "Follow step progress below. Results appear after execution is confirmed.")}
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              <p>{detail.run.repository}</p>
              <p>
                {detail.runtimeState
                  ? `${detail.runtimeState.nodesTotal} workflow nodes`
                  : `${detail.workflow.steps.length} workflow steps`}{" "}
                · Pinned configuration
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {state === "waiting" ? (
              <Button
                onClick={() =>
                  navigation.update({
                    view: "inbox",
                    factoryId,
                    runId: undefined,
                    attemptId: undefined,
                    nodePath: undefined,
                  })
                }
              >
                Review decisions
              </Button>
            ) : null}
            {(["pause", "resume", "cancel", "retry"] as const)
              .filter((action) => available[action])
              .map((action) => (
                <Button
                  key={action}
                  variant={
                    action === "cancel"
                      ? "destructive-outline"
                      : (action === "resume" && state === "paused") || action === "retry"
                        ? "default"
                        : "outline"
                  }
                  disabled={busy || !canControl || !detail.control || !available[action]}
                  onClick={() => void act(action)}
                >
                  {action.charAt(0).toUpperCase() + action.slice(1)}
                </Button>
              ))}
          </div>
          {!canControl ? (
            <p className="text-sm text-muted-foreground">
              Your current session can review this run but cannot control execution.
            </p>
          ) : null}
          {!terminal ? (
            <p className="text-xs text-muted-foreground">
              Pause prevents new steps while accepted work can finish. Cancel requests a stop;
              confirmation waits for the writer to end. Retry creates a new attempt only when safe.
            </p>
          ) : null}
          {detail.control?.state === "waiting" || detail.control?.reason ? (
            <Link className="text-sm underline" to="/foundry" search={{ view: "inbox", factoryId }}>
              Review questions, decisions and blockers
            </Link>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {detail?.decisions?.length ? (
        <section className="space-y-2" aria-label="Recorded decisions">
          <h3 className="font-semibold">Recorded decisions</h3>
          <p className="text-xs text-muted-foreground">
            Latest 100 recorded decisions. Approval applies to its recorded result revision.
          </p>
          <ul>
            {detail.decisions.map((decision) => (
              <li key={decision.revision} className="text-sm">
                {decision.stepId}: {decision.approved ? "Approved" : "Rejected"} · Decision revision{" "}
                {decision.revision} · Result revision {decision.resultRevision}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {detail && !selected && attempts.result?.kind === "attempts" ? (
        <section className="space-y-3" aria-label="Recorded result">
          <h3 className="text-lg font-semibold">Recorded result</h3>
          <p className="text-xs text-muted-foreground">
            Last reported workflow step on this history page. Execution success is separate from
            work item acceptance.
          </p>
          {latestReport ? (
            <AttemptResult
              environmentId={environmentId}
              factoryId={factoryId}
              runId={runId}
              commandId={latestReport.commandId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No execution report on this page. Review workflow decisions and other history pages
              below.
            </p>
          )}
        </section>
      ) : null}
      {topology && execution ? (
        <section
          className="space-y-5 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
          aria-label="Parallel execution plan"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Branches → join → follow-up</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant="info">Up to {execution.maxParallelism} parallel steps</Badge>
              <Badge variant="outline">
                {execution.maxRepairRounds} repair rounds per failed branch
              </Badge>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Dependencies from this run's pinned workflow. Independent steps may run together when
            authorized worker capacity is available.
          </p>
          <div className="flex flex-wrap items-start gap-4">
            {topology.levels.map((level, index) => (
              <div key={level.join(":")} className="min-w-0 space-y-2">
                <p className="text-xs text-muted-foreground">Dependency level {index + 1}</p>
                <ul className="space-y-2">
                  {level.map((id) => (
                    <li key={id}>
                      <a
                        className="block break-words rounded-md border px-3 py-2 text-sm underline"
                        href={`#run-step-${encodeURIComponent(id)}`}
                      >
                        {id}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="min-w-0 space-y-2">
              <p className="text-xs text-muted-foreground">All branches must succeed</p>
              <a
                className="block break-words rounded-md border px-3 py-2 text-sm font-medium underline"
                href={`#run-step-${encodeURIComponent(topology.join.id)}`}
              >
                Join: {topology.join.id}
              </a>
            </div>
            {topology.suffix.length ? (
              <div className="min-w-0 space-y-2">
                <p className="text-xs text-muted-foreground">Serial follow-up</p>
                <ol className="space-y-2">
                  {topology.suffix.map((step) => (
                    <li key={step.id}>
                      <a
                        className="block break-words rounded-md border px-3 py-2 text-sm underline"
                        href={`#run-step-${encodeURIComponent(step.id)}`}
                      >
                        {step.id} · {step.kind}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            The join agent receives ordered branch summaries and artifact references. This does not
            automatically merge Git branches. Attempt states below reflect the loaded page, not an
            aggregate of all attempts.
          </p>
        </section>
      ) : null}
      {detail?.runtimeWorkflow ? (
        <V4RunProgress
          state={detail.runtimeState}
          workflow={detail.runtimeWorkflow}
          environmentId={environmentId}
          factoryId={factoryId}
          runId={runId}
          onPage={setNodesAfter}
        />
      ) : null}
      {detail && !detail.runtimeWorkflow ? (
        <section className="space-y-3" aria-label="Workflow steps">
          <h3 className="text-lg font-semibold">Workflow</h3>
          <ol className="divide-y border-y">
            {detail.workflow.steps.map((step, index) => (
              <li
                key={step.id}
                id={`run-step-${encodeURIComponent(step.id)}`}
                className="scroll-mt-16 py-3"
              >
                <details>
                  <FoundryUI.Summary className="cursor-pointer text-sm">
                    <span className="font-medium">
                      {index + 1}. {step.id}
                    </span>{" "}
                    ·{" "}
                    {step.kind === "agent"
                      ? (step.resolved?.role?.name ?? "Agent")
                      : step.kind === "test"
                        ? "Checks"
                        : step.kind === "publish"
                          ? "Publication"
                          : "Human decision"}
                  </FoundryUI.Summary>
                  <div className="space-y-2 pt-2 text-sm">
                    {step.kind === "agent" || step.kind === "approval" ? (
                      <p className="whitespace-pre-wrap break-words">{step.prompt}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {step.dependsOn.length
                        ? `After: ${step.dependsOn.join(", ")}`
                        : "No dependencies"}
                    </p>
                    {step.kind === "approval" ? (
                      <Link
                        className="underline"
                        to="/foundry"
                        search={{ view: "inbox", factoryId, inboxKind: "approval" }}
                      >
                        Review current decisions
                      </Link>
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {detail ? (
        <details className="rounded-lg border p-4">
          <FoundryUI.Summary className="cursor-pointer font-medium">
            Continue in chat
          </FoundryUI.Summary>
          <div className="pt-4">
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
          </div>
        </details>
      ) : null}
      {detail && attempts.result?.kind === "attempts" ? (
        <section className="space-y-3" aria-label="Execution history">
          <div>
            <h3 className="text-lg font-semibold">Execution history</h3>
            <p className="text-xs text-muted-foreground">
              {detail.runtimeWorkflow
                ? "Each execution has its own technical retries. Review rounds are grouped in the workflow above."
                : "Open an execution to review its result, evidence and pinned configuration."}
            </p>
          </div>
          {attempts.result.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No executions on this page.</p>
          ) : null}
          <ol className="divide-y border-y">
            {attempts.result.items
              .toSorted(
                (left, right) =>
                  left.ordinal - right.ordinal || left.attemptNumber - right.attemptNumber,
              )
              .map((attempt) => {
                const { node, step, label } = runExecutionStep(detail, attempt.ordinal);
                return (
                  <li key={attempt.commandId} className="min-w-0 space-y-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <h4 className="break-words font-medium">{label}</h4>
                          <Badge variant={runStatusVariant(attempt.state)}>
                            {attempt.state.replaceAll("_", " ")}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {attempt.attemptNumber === 0
                              ? "Initial execution"
                              : detail.runtimeWorkflow
                                ? `Technical retry ${attempt.attemptNumber}`
                                : execution && topology && attempt.ordinal < topology.joinIndex
                                  ? `Repair round ${attempt.attemptNumber}`
                                  : `Attempt ${attempt.attemptNumber + 1}`}
                          </span>
                        </div>
                        {node?.scope ? (
                          <p className="text-xs text-muted-foreground">
                            {runScopeLabel(node.scope)}
                          </p>
                        ) : null}
                        {attempt.reason ? (
                          <p className="text-sm text-muted-foreground">
                            {attempt.reason.replaceAll("_", " ")}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        variant={attempt.hasResult ? "outline" : "ghost"}
                        aria-expanded={selected === attempt.commandId}
                        aria-controls={`attempt-${attempt.commandId}`}
                        onClick={() =>
                          setSelected(
                            selected === attempt.commandId ? undefined : attempt.commandId,
                          )
                        }
                      >
                        {selected === attempt.commandId
                          ? "Close details"
                          : attempt.hasResult
                            ? "Review result & evidence"
                            : "Inspect execution"}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs">
                      {attempt.threadId && attempt.environmentId ? (
                        <>
                          <a
                            className="underline"
                            href={`/${encodeURIComponent(attempt.environmentId)}/${encodeURIComponent(attempt.threadId)}?factoryId=${encodeURIComponent(factoryId)}&runId=${encodeURIComponent(runId)}`}
                          >
                            Open chat
                          </a>
                          <a
                            className="underline"
                            href={`/foundry?archiveEnvironmentId=${encodeURIComponent(attempt.environmentId)}&archiveThreadId=${encodeURIComponent(attempt.threadId)}`}
                          >
                            Read central archive
                          </a>
                        </>
                      ) : null}
                      <details>
                        <FoundryUI.Summary className="cursor-pointer text-muted-foreground">
                          Worker & step details
                        </FoundryUI.Summary>
                        <div className="space-y-2 break-words pt-2">
                          <p className="break-all">
                            Worker: {attempt.workerId ?? "Not assigned"} · Environment:{" "}
                            {attempt.environmentId ?? "Not assigned"}
                          </p>
                          {attempt.capacityReleased !== undefined ? (
                            <p>Capacity {attempt.capacityReleased ? "released" : "reserved"}</p>
                          ) : null}
                          {step?.kind === "agent" || step?.kind === "approval" ? (
                            <p className="whitespace-pre-wrap">{step.prompt}</p>
                          ) : null}
                          {step?.kind === "agent" && step.resolved ? (
                            <>
                              <p>
                                Agent: {step.resolved.role?.name ?? "Agent"} · Model:{" "}
                                {step.resolved.execution.model ??
                                  detail.executionBinding?.model ??
                                  "Run binding model"}
                              </p>
                              <p>
                                Skills:{" "}
                                {step.resolved.skills.map((skill) => skill.name).join(", ") ||
                                  "None"}
                              </p>
                              <p className="whitespace-pre-wrap">{step.resolved.instructions}</p>
                            </>
                          ) : null}
                          {!step ? (
                            <p>
                              Step configuration is on another workflow page. Open this execution
                              for its pinned configuration.
                            </p>
                          ) : null}
                        </div>
                      </details>
                    </div>
                    {selected === attempt.commandId ? (
                      <div id={`attempt-${attempt.commandId}`}>
                        <AttemptResult
                          environmentId={environmentId}
                          factoryId={factoryId}
                          runId={runId}
                          commandId={attempt.commandId}
                        />
                      </div>
                    ) : null}
                    {!attempt.hasResult ? (
                      <p className="text-xs text-muted-foreground">
                        {step?.kind === "approval" || node?.definition.kind === "approval"
                          ? "Human decision step. Review its recorded decision in Decisions; no worker report is expected."
                          : "No execution report is attached to this step."}
                      </p>
                    ) : null}
                  </li>
                );
              })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              {attempts.result.items.length} executions on this page
            </p>
            <Button variant="outline" disabled={!after} onClick={() => setAfter(undefined)}>
              First executions
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
              Next executions
            </Button>
          </div>
        </section>
      ) : null}
      {selected &&
      attempts.result?.kind === "attempts" &&
      !attempts.result.items.some((attempt) => attempt.commandId === selected) ? (
        <section className="space-y-2">
          <Button variant="ghost" onClick={() => setSelected(undefined)}>
            Close selected execution
          </Button>
          <AttemptResult
            environmentId={environmentId}
            factoryId={factoryId}
            runId={runId}
            commandId={selected}
          />
        </section>
      ) : null}
      {detail ? (
        <>
          <details className="rounded-lg border p-3">
            <FoundryUI.Summary className="cursor-pointer text-sm">
              Run identity, revisions and pinned source
            </FoundryUI.Summary>
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

          <HandoffList
            environmentId={environmentId}
            factoryId={factoryId}
            workItemId={detail.run.workItemId}
          />
        </>
      ) : null}
      {detail ? (
        <details>
          <FoundryUI.Summary>Operations and evaluations</FoundryUI.Summary>
          <OperationsDashboardPanel
            environmentId={environmentId}
            factoryId={factoryId}
            runId={runId}
          />
          <EvaluationsPanel environmentId={environmentId} factoryId={factoryId} runId={runId} />
        </details>
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
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "attempt",
    factoryId,
    runId,
    commandId,
  });
  return (
    <section className="min-w-0 space-y-4 rounded-lg bg-muted/30 p-4" aria-label="Attempt result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">Result & evidence</h4>
        <Button variant="ghost" onClick={refresh}>
          Refresh evidence
        </Button>
      </div>
      {loading ? <p role="status">Loading result…</p> : null}
      {error ? <FoundryUI.Notice>{error}</FoundryUI.Notice> : null}
      {result?.kind === "attempt" ? (
        <>
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
          <h5 className="text-sm font-medium">Artifacts</h5>
          {result.artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No separate files are attached. A result may still be recorded in the chat archive.
            </p>
          ) : null}
          <ul className="space-y-2">
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
          {result.execution?.lifecycle?.manifest?.archive ? (
            <a
              className="text-sm underline"
              href={`/foundry?archiveEnvironmentId=${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.environmentId)}&archiveThreadId=${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.threadId)}`}
            >
              Read recorded conversation and result
            </a>
          ) : null}
          {result.execution?.lifecycle?.manifest?.workspacePath ? (
            <p className="break-all text-sm">
              Workspace: {result.execution.lifecycle.manifest.workspacePath}
            </p>
          ) : null}
          <p className="text-sm">Worker run: {result.execution?.run.status ?? "No final result"}</p>
          {result.resources ? (
            <details>
              <FoundryUI.Summary className="cursor-pointer text-sm">
                Effective agent, skills & MCP
              </FoundryUI.Summary>
              <div className="pt-3">
                <V4AgentConfiguration agent={result.resources} />
              </div>
            </details>
          ) : null}
          {result.launch ? (
            <details>
              <FoundryUI.Summary className="cursor-pointer text-sm">
                Actual worker launch configuration
              </FoundryUI.Summary>
              <div className="space-y-2 pt-2 text-sm">
                <p>
                  Model: {result.launch.model} · Reasoning:{" "}
                  {result.launch.options?.reasoningEffort ?? "Provider default"}
                </p>
                <p className="break-all">
                  Project: {result.launch.projectId} · Workspace mode:{" "}
                  {result.launch.workspaceMode ?? "Not recorded"}
                </p>
                {result.launch.workspaceRevision ? (
                  <p className="break-all">Workspace revision: {result.launch.workspaceRevision}</p>
                ) : null}
                <p className="whitespace-pre-wrap">{result.launch.prompt}</p>
              </div>
            </details>
          ) : null}
          <details className="text-sm">
            <FoundryUI.Summary className="cursor-pointer">
              Checkpoint, writer shutdown & archive completeness
            </FoundryUI.Summary>
            <div className="space-y-2 break-all pt-2">
              <div className="text-sm">
                Checkpoint: {result.execution?.run.checkpointId ? "Recorded" : "Unconfirmed"}
                {result.execution?.run.checkpointId ? (
                  <details>
                    <summary className="cursor-pointer">Internal checkpoint reference</summary>
                    <code>{result.execution.run.checkpointId}</code>
                  </details>
                ) : null}
              </div>
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
            </div>
          </details>
          {result.execution?.lifecycle?.manifest?.archive ? (
            <a
              className="text-sm underline"
              href={`/${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.environmentId)}/${encodeURIComponent(result.execution.lifecycle.manifest.archive.owner.threadId)}?factoryId=${encodeURIComponent(factoryId)}&runId=${encodeURIComponent(runId)}`}
            >
              Open chat to review changes
            </a>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
