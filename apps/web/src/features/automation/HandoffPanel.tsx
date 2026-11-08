import { FoundryUI } from "../../foundry/FoundryUI";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type {
  AutomationHandoff,
  AutomationHandoffCommand,
  AutomationControlSnapshot,
  AutomationAttemptSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";
import { handoffFailureMessage, isDefinitiveAutomationFailure } from "./failures";

function useHandoffCommand(environmentId: EnvironmentId, refresh: () => void) {
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(automationCommands.command.permissionAtom(environmentId));
  const [pending, setPending] = useState<AutomationHandoffCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function execute(input: AutomationHandoffCommand) {
    if (busy) return;
    setPending(input);
    setBusy(true);
    const response = await command({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(response)) {
      setPending(null);
      setMessage("Handoff decision confirmed. Check the current state below.");
    } else {
      const failure = squashAtomCommandFailure(response);
      if (isDefinitiveAutomationFailure(failure)) setPending(null);
      setMessage(handoffFailureMessage(failure));
    }
    refresh();
  }
  return { allowed, pending, busy, message, execute };
}

export function TakeOverPanel({
  environmentId,
  factoryId,
  runId,
  control,
  attempts,
  refresh,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId: string;
  control: AutomationControlSnapshot | null;
  attempts: readonly AutomationAttemptSummary[];
  refresh: () => void;
}) {
  const [sourceCommandId, setSourceCommandId] = useState("");
  const [mode, setMode] = useState<AutomationHandoff["mode"]>("existing");
  const action = useHandoffCommand(environmentId, refresh);
  const eligible =
    control !== null && ["paused", "succeeded", "failed", "cancelled"].includes(control.state);
  return (
    <section
      aria-label="Take over in T3"
      className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-6"
    >
      <h3 className="text-lg font-semibold">Continue interactively</h3>
      <p className="text-sm text-muted-foreground">
        Continue from a confirmed checkpoint. Pause an active run and wait for its current work to
        finish before taking over.
      </p>
      <fieldset
        disabled={action.busy || !action.allowed || Boolean(action.pending)}
        className="space-y-2"
      >
        <legend className="text-sm">Choose the source attempt</legend>
        {attempts
          .filter((attempt) => attempt.threadId)
          .map((attempt) => (
            <label key={attempt.commandId} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`handoff-source-${runId}`}
                checked={sourceCommandId === attempt.commandId}
                onChange={() => setSourceCommandId(attempt.commandId)}
              />
              Step {attempt.ordinal + 1} · Attempt {attempt.attemptNumber + 1} · {attempt.state}
            </label>
          ))}
        <div className="flex flex-wrap gap-2">
          {(["existing", "branch", "archive"] as const).map((value) => (
            <Button
              key={value}
              size="multiline"
              variant={mode === value ? "default" : "outline"}
              onClick={() => setMode(value)}
            >
              {value === "existing"
                ? "Existing workspace"
                : value === "branch"
                  ? "Alternative branch"
                  : "Restore archived workspace"}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "existing"
            ? "Open a linked interactive thread in the existing workspace."
            : mode === "branch"
              ? "Create a separate branch and thread from the confirmed source checkpoint."
              : "Create a new workspace from the centrally confirmed archive. Missing archive data blocks restoration."}
        </p>
      </fieldset>
      <Button
        disabled={
          action.busy || !action.allowed || (!action.pending && (!eligible || !sourceCommandId))
        }
        onClick={() => {
          if (!control) return;
          void action.execute(
            action.pending ?? {
              op: "takeOver",
              commandId: randomUUID(),
              id: randomUUID(),
              factoryId,
              runId,
              expectedRevision: control.revision,
              sourceCommandId,
              mode,
            },
          );
        }}
      >
        {action.busy
          ? "Taking over…"
          : action.pending
            ? "Retry the same takeover"
            : "Take over in T3"}
      </Button>
      {!action.allowed ? (
        <p className="text-sm text-muted-foreground">
          Your connection can view this run but cannot take over its workspace.
        </p>
      ) : !eligible ? (
        <p className="text-sm text-muted-foreground">
          Pause the run and wait for its current work to finish before taking over.
        </p>
      ) : attempts.every((attempt) => !attempt.threadId) ? (
        <p className="text-sm text-muted-foreground">
          No source thread is available on this attempts page. Open another page or wait for an
          execution to finish.
        </p>
      ) : null}
      {action.message ? <p role="status">{action.message}</p> : null}
      {action.pending ? (
        <p className="text-xs">
          Confirmation is pending. Retry keeps the same command and handoff ID.
        </p>
      ) : null}
    </section>
  );
}

export function HandoffList({
  environmentId,
  factoryId,
  workItemId,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  workItemId: string;
}) {
  const query = useAutomationQuery(environmentId, { op: "handoffs", factoryId, workItemId });
  return (
    <section aria-label="Interactive handoffs" className="space-y-3">
      <h3 className="text-lg font-semibold">Interactive work</h3>
      {query.loading && !query.result ? <p role="status">Loading interactive work…</p> : null}
      {query.error ? <FoundryUI.Notice>{query.error}</FoundryUI.Notice> : null}
      {query.result?.kind === "handoffs" ? (
        query.result.items.length ? (
          query.result.items.map((handoff) => (
            <HandoffPanel
              key={handoff.id}
              environmentId={environmentId}
              handoff={handoff}
              refresh={query.refresh}
            />
          ))
        ) : (
          <p className="text-sm">
            No interactive work yet. You can take over a paused or finished run in T3.
          </p>
        )
      ) : null}
    </section>
  );
}

function HandoffPanel({
  environmentId,
  handoff,
  refresh,
}: {
  environmentId: EnvironmentId;
  handoff: AutomationHandoff;
  refresh: () => void;
}) {
  const [tests, setTests] = useState("");
  const [openPoints, setOpenPoints] = useState("");
  const action = useHandoffCommand(environmentId, refresh);
  const receipt = handoff.receipt;
  const pendingCommands =
    action.pending &&
    !handoff.pendingCommands.some((entry) => entry.commandId === action.pending?.commandId)
      ? [...handoff.pendingCommands, action.pending]
      : handoff.pendingCommands;
  return (
    <section aria-label="Interactive handoff" className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            handoff.state === "open"
              ? "info"
              : handoff.state === "returning"
                ? "warning"
                : "secondary"
          }
        >
          {handoff.state.replaceAll("_", " ")}
        </Badge>
        <span className="text-sm">
          {handoff.mode === "existing"
            ? "Existing workspace"
            : handoff.mode === "branch"
              ? "Alternative branch"
              : "Restored archive"}
        </span>
      </div>
      {receipt ? (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <a
              className="underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              href={`/${encodeURIComponent(handoff.environmentId)}/${encodeURIComponent(receipt.threadId)}?factoryId=${encodeURIComponent(handoff.factoryId)}&runId=${encodeURIComponent(handoff.runId)}`}
            >
              Open interactive chat
            </a>
            <a
              className="underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              href={`/foundry?archiveEnvironmentId=${encodeURIComponent(handoff.environmentId)}&archiveThreadId=${encodeURIComponent(receipt.threadId)}`}
            >
              Read central archive
            </a>
            <a
              className="underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              href={`/${encodeURIComponent(handoff.environmentId)}/${encodeURIComponent(receipt.sourceThreadId)}?factoryId=${encodeURIComponent(handoff.factoryId)}&runId=${encodeURIComponent(handoff.runId)}`}
            >
              Source execution thread
            </a>
          </div>
          <p className="text-sm text-muted-foreground">
            This interactive chat remains in Chats after return. Automated execution stays in the
            factory run history.
          </p>
        </>
      ) : (
        <p className="text-sm">Workspace opening is not yet confirmed.</p>
      )}
      {handoff.state === "open" && pendingCommands.length === 0 ? (
        <>
          <fieldset
            disabled={action.busy || !action.allowed || Boolean(action.pending)}
            className="space-y-2"
          >
            <legend className="font-medium">Return to factory</legend>
            <p className="text-sm">
              Finish interactive work before returning. The server confirms the checkpoint and
              archive, then creates a paused continuation of this work item. Resume it explicitly
              when ready.
            </p>
            <label className="block space-y-1">
              <span className="text-sm">Tests performed (your report)</span>
              <Textarea
                maxLength={20_000}
                value={tests}
                onChange={(event) => setTests(event.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">Open points</span>
              <Textarea
                maxLength={20_000}
                value={openPoints}
                onChange={(event) => setOpenPoints(event.target.value)}
              />
            </label>
          </fieldset>
          <Button
            disabled={action.busy || !action.allowed || !receipt}
            onClick={() => {
              if (!receipt) return;
              void action.execute(
                action.pending ?? {
                  op: "returnHandoff",
                  commandId: randomUUID(),
                  factoryId: handoff.factoryId,
                  handoffId: handoff.id,
                  expectedGeneration: handoff.generation,
                  expectedBaseCommit: receipt.baseCommit,
                  tests,
                  openPoints,
                },
              );
            }}
          >
            {action.busy
              ? "Returning…"
              : action.pending
                ? "Retry the same return"
                : "Return to factory"}
          </Button>
        </>
      ) : null}
      {!action.allowed && handoff.state === "open" ? (
        <p className="text-sm text-muted-foreground">
          Your connection can read this handoff but cannot return it to the factory.
        </p>
      ) : null}
      {handoff.state === "returning" ? (
        <>
          <p className="text-sm">
            Return is awaiting confirmation. Retry the saved return first. To correct a blocked
            result, explicitly reopen interactive work. If the worker has already finalized the
            return, reopening is refused; retry the original return to confirm it centrally.
          </p>
          <Button
            variant="outline"
            disabled={
              action.busy ||
              !action.allowed ||
              pendingCommands.some((pending) => pending.op === "reopenHandoff")
            }
            onClick={() =>
              void action.execute({
                op: "reopenHandoff",
                commandId: randomUUID(),
                factoryId: handoff.factoryId,
                handoffId: handoff.id,
                expectedGeneration: handoff.generation,
              })
            }
          >
            Reopen interactive work
          </Button>
        </>
      ) : null}
      {pendingCommands.map((pending) => (
        <div key={pending.commandId} className="space-y-2">
          <p className="text-sm">
            A saved decision is awaiting confirmation. Retrying sends its original command and
            report, including after reloading this page.
          </p>
          {pending.op === "returnHandoff" ? (
            <div className="text-sm">
              <p className="whitespace-pre-wrap">
                Saved tests report: {pending.tests || "None reported"}
              </p>
              <p className="whitespace-pre-wrap">
                Saved open points: {pending.openPoints || "None reported"}
              </p>
            </div>
          ) : null}
          <Button
            variant="outline"
            disabled={action.busy || !action.allowed}
            onClick={() => {
              void action.execute(pending);
            }}
          >
            {pending.op === "takeOver"
              ? "Retry pending takeover"
              : pending.op === "returnHandoff"
                ? "Retry pending return"
                : "Retry pending reopen"}
          </Button>
        </div>
      ))}
      {handoff.result ? (
        <div className="space-y-2 border-t pt-3 text-sm">
          <h4 className="font-medium">Return confirmed</h4>
          <p className="text-muted-foreground">
            The checkpoint and central archive are saved. Open the continuation to review and resume
            the workflow.
          </p>
          <details>
            <FoundryUI.Summary className="cursor-pointer text-xs text-muted-foreground">
              Confirmed checkpoint and archive
            </FoundryUI.Summary>
            <div className="space-y-1 pt-2 text-xs text-muted-foreground">
              <p className="break-all">Commit: {handoff.result.commitSha}</p>
              <p className="break-all">Checkpoint: {handoff.result.checkpointRef}</p>
              <p>Central archive confirmed through event {handoff.result.archive.cursor}.</p>
            </div>
          </details>
          <p className="whitespace-pre-wrap">
            Reported tests: {handoff.result.tests || "None reported"}
          </p>
          <p className="whitespace-pre-wrap">
            Open points: {handoff.result.openPoints || "None reported"}
          </p>
        </div>
      ) : null}
      {handoff.continuationRunId ? (
        <a
          className="text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          href={`/foundry?view=runs&factoryId=${encodeURIComponent(handoff.factoryId)}&runId=${encodeURIComponent(handoff.continuationRunId)}`}
        >
          Open continuation run (created paused)
        </a>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <FoundryUI.Summary className="cursor-pointer">
          Workspace & revision details
        </FoundryUI.Summary>
        <div className="space-y-1 break-all pt-2">
          <p>
            Input revision: {handoff.baseRevision} · Generation {handoff.generation}
          </p>
          {receipt ? (
            <>
              <p>Base commit: {receipt.baseCommit}</p>
              <p>
                Workspace: {receipt.workspacePath} · Branch: {receipt.branch ?? "detached"}
              </p>
            </>
          ) : null}
        </div>
      </details>
      {action.message ? <p role="status">{action.message}</p> : null}
    </section>
  );
}
