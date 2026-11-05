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
    <section aria-label="Take over in T3" className="space-y-3 rounded border p-3">
      <h3 className="font-medium">Take over in T3</h3>
      <p className="text-sm">
        Pause an active run first and wait for its writer to finish. Finished runs can also be taken
        over. The server verifies writer shutdown and the saved checkpoint before opening
        interactive work.
      </p>
      <fieldset disabled={action.busy || Boolean(action.pending)} className="space-y-2">
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
      {!eligible ? <p className="text-sm">Pause the run before taking over.</p> : null}
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
      <h3 className="font-medium">Interactive handoffs</h3>
      {query.error ? <p role="alert">{query.error}</p> : null}
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
          <p className="text-sm">No interactive handoff. Open a run to take over an attempt.</p>
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
    <section aria-label="Interactive handoff" className="space-y-3 rounded border p-3">
      <p className="text-sm">
        {handoff.state} · Generation {handoff.generation} · {handoff.mode}
      </p>
      <p className="break-all text-sm">Input revision: {handoff.baseRevision}</p>
      {receipt ? (
        <>
          <p className="break-all text-sm">Base commit: {receipt.baseCommit}</p>
          <p className="break-all text-sm">
            Workspace: {receipt.workspacePath} · Branch: {receipt.branch ?? "detached"}
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            <a
              className="underline"
              href={`/${encodeURIComponent(handoff.environmentId)}/${encodeURIComponent(receipt.threadId)}`}
            >
              Open T3 thread
            </a>
            <a
              className="underline"
              href={`/foundry?archiveEnvironmentId=${encodeURIComponent(handoff.environmentId)}&archiveThreadId=${encodeURIComponent(receipt.threadId)}`}
            >
              Read central archive
            </a>
          </div>
        </>
      ) : (
        <p className="text-sm">Workspace opening is not yet confirmed.</p>
      )}
      {handoff.state === "open" && pendingCommands.length === 0 ? (
        <>
          <fieldset disabled={action.busy || Boolean(action.pending)} className="space-y-2">
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
        <div className="space-y-1 text-sm">
          <p className="break-all">Confirmed return commit: {handoff.result.commitSha}</p>
          <p className="break-all">Checkpoint: {handoff.result.checkpointRef}</p>
          <p>Central archive confirmed through event {handoff.result.archive.cursor}.</p>
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
          className="text-sm underline"
          href={`/foundry?view=runs&factoryId=${encodeURIComponent(handoff.factoryId)}&runId=${encodeURIComponent(handoff.continuationRunId)}`}
        >
          Open continuation run (created paused)
        </a>
      ) : null}
      {action.message ? <p role="status">{action.message}</p> : null}
    </section>
  );
}
