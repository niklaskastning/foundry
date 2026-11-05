import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AutomationControlCommand,
  AutomationInboxEntry,
  AutomationInboxMark,
  EnvironmentId,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useAutomationQuery } from "./useAutomationQuery";
import { AttemptResult } from "./RunDetail";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isDefinitiveAutomationFailure } from "./failures";
import { randomUUID } from "../../lib/utils";

const answerText = (value: unknown) => (typeof value === "string" ? value : "");
const hasAnswer = (value: unknown, option: string) =>
  Array.isArray(value) && value.includes(option);

export function InboxDetail({
  environmentId,
  item,
  onChanged,
  onClose,
  onNavigateRun,
  onNavigateWorkItem,
}: {
  environmentId: EnvironmentId;
  item: AutomationInboxEntry;
  onChanged: () => void;
  onClose: () => void;
  onNavigateRun?: (factoryId: string, runId: string) => void;
  onNavigateWorkItem?: (factoryId: string, workItemId: string) => void;
}) {
  const mark = useAtomCommand(automationCommands.inboxMark, { reportFailure: false });
  const control = useAtomCommand(automationCommands.control, { reportFailure: false });
  const canMark = useAtomValue(automationCommands.inboxMark.permissionAtom(environmentId));
  const canDecide = useAtomValue(automationCommands.control.permissionAtom(environmentId));
  const [showEvidence, setShowEvidence] = useState(false);
  const [answers, setAnswers] = useState<ProviderUserInputAnswers>({});
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<AutomationControlCommand["action"] | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const pendingMark = useRef<AutomationInboxMark | null>(null);
  const pendingControl = useRef<AutomationControlCommand | null>(null);
  const inFlight = useRef(false);
  async function changeMark(action: AutomationInboxMark["action"]) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const input =
      pendingMark.current?.action === action
        ? pendingMark.current
        : { commandId: randomUUID(), itemId: item.id, sourceRevision: item.sourceRevision, action };
    pendingMark.current = input;
    const result = await mark({ environmentId, input });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      pendingMark.current = null;
      onChanged();
    } else {
      if (isDefinitiveAutomationFailure(squashAtomCommandFailure(result))) {
        pendingMark.current = null;
        onChanged();
      }
      setMessage(
        "The mark could not be saved. Retry sends the same command; refresh if this item changed.",
      );
    }
  }
  async function decide(action: "approve" | "reject" | "answer") {
    if (inFlight.current || (pendingControl.current && pendingControl.current.action !== action))
      return;
    const base = {
      commandId: randomUUID(),
      factoryId: item.factoryId,
      runId: item.runId,
      expectedRevision: item.expectedRevision,
      resultRevision: item.resultRevision,
    };
    const input =
      pendingControl.current ??
      (action === "answer" && item.requestId
        ? { ...base, action, requestId: item.requestId, answers }
        : action !== "answer" && item.stepId
          ? { ...base, action, stepId: item.stepId }
          : null);
    if (!input) return;
    inFlight.current = true;
    setBusy(true);
    pendingControl.current = input;
    setPendingAction(input.action);
    const result = await control({ environmentId, input });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      pendingControl.current = null;
      setPendingAction(null);
      setMessage("Decision recorded.");
      onChanged();
    } else {
      if (isDefinitiveAutomationFailure(squashAtomCommandFailure(result))) {
        pendingControl.current = null;
        setPendingAction(null);
        onChanged();
      }
      setMessage(
        "Decision was not confirmed. Retry sends the same command. Refresh to inspect changed revisions or permissions.",
      );
    }
  }
  return (
    <aside className="space-y-4 rounded-lg border p-4" aria-label="Inbox item details">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-medium">{item.title}</h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="whitespace-pre-wrap text-sm">{item.detail}</p>
      <p className="text-xs text-muted-foreground">
        {item.active ? "Current" : "Resolved or superseded"} · Revision {item.expectedRevision} ·
        Result {item.resultRevision}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !canMark}
          onClick={() => void changeMark(item.isRead ? "unread" : "read")}
        >
          {item.isRead ? "Mark unread" : "Mark read"}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !canMark}
          onClick={() => void changeMark(item.isDone ? "reopen" : "done")}
        >
          {item.isDone ? "Undo done" : "Mark done"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Marking done only organizes your inbox. It does not approve a result or answer a question.
      </p>
      <div className="space-y-3">
        <Button variant="outline" onClick={() => setShowEvidence(!showEvidence)}>
          {showEvidence ? "Hide evidence" : "Review tests, changes and artifacts"}
        </Button>
        {showEvidence ? <InboxEvidence environmentId={environmentId} item={item} /> : null}
      </div>
      {item.kind === "approval" && item.active ? (
        <div className="space-y-2">
          <p className="text-sm">
            Review the run and its results before approving this exact revision.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={
                busy || !canDecide || (pendingAction !== null && pendingAction !== "approve")
              }
              onClick={() => void decide("approve")}
            >
              Approve revision
            </Button>
            <Button
              variant="outline"
              disabled={
                busy || !canDecide || (pendingAction !== null && pendingAction !== "reject")
              }
              onClick={() => void decide("reject")}
            >
              Reject revision
            </Button>
          </div>
        </div>
      ) : null}
      {item.kind === "question" && item.active ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void decide("answer");
          }}
        >
          {item.questions.map((question) => (
            <fieldset
              className="space-y-2"
              key={question.id}
              disabled={busy || !canDecide || pendingAction !== null}
            >
              <legend className="text-sm font-medium">{question.header}</legend>
              <p className="text-sm">{question.question}</p>
              {question.options.map((option) => (
                <label
                  key={option.value ?? option.label}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={question.id}
                    checked={
                      question.multiSelect
                        ? hasAnswer(answers[question.id], option.value ?? option.label)
                        : answers[question.id] === (option.value ?? option.label)
                    }
                    onChange={(event) => {
                      const value = option.value ?? option.label;
                      const selected = answers[question.id];
                      setAnswers({
                        ...answers,
                        [question.id]: question.multiSelect
                          ? event.target.checked
                            ? [...(Array.isArray(selected) ? selected : []), value]
                            : (Array.isArray(selected) ? selected : []).filter(
                                (entry) => entry !== value,
                              )
                          : value,
                      });
                    }}
                  />
                  <span>
                    {option.label}
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
              {question.allowCustomAnswer !== false || question.options.length === 0 ? (
                <label className="block space-y-1">
                  <span className="text-sm">Your answer</span>
                  <Textarea
                    value={answerText(answers[question.id])}
                    onChange={(event) =>
                      setAnswers({ ...answers, [question.id]: event.target.value })
                    }
                  />
                </label>
              ) : null}
            </fieldset>
          ))}
          <Button
            type="submit"
            disabled={
              busy ||
              !canDecide ||
              item.questions.length === 0 ||
              item.questions.some(
                (question) =>
                  question.required !== false &&
                  (answers[question.id] === undefined || answers[question.id] === ""),
              )
            }
          >
            Send answer
          </Button>
        </form>
      ) : null}
      {item.kind === "answer" && item.answer ? (
        <dl className="space-y-2 text-sm">
          {Object.entries(item.answer).map(([key, answer]) => (
            <div key={key}>
              <dt className="font-medium">{key}</dt>
              <dd className="whitespace-pre-wrap">
                {typeof answer === "string" ? answer : JSON.stringify(answer)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <nav className="flex flex-wrap gap-2" aria-label="Inbox references">
        {onNavigateWorkItem ? (
          <Button
            variant="outline"
            onClick={() => onNavigateWorkItem(item.factoryId, item.workItemId)}
          >
            Open work item
          </Button>
        ) : null}
        {onNavigateRun ? (
          <Button variant="outline" onClick={() => onNavigateRun(item.factoryId, item.runId)}>
            Open run
          </Button>
        ) : null}
        {item.threadId && item.environmentId ? (
          <Button
            variant="outline"
            onClick={() =>
              window.location.assign(
                `/${encodeURIComponent(item.environmentId!)}/${encodeURIComponent(item.threadId!)}?factoryId=${encodeURIComponent(item.factoryId)}&runId=${encodeURIComponent(item.runId)}`,
              )
            }
          >
            Open T3 thread
          </Button>
        ) : null}
      </nav>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </aside>
  );
}

function InboxEvidence({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: AutomationInboxEntry;
}) {
  const run = useAutomationQuery(environmentId, {
    op: "run",
    factoryId: item.factoryId,
    runId: item.runId,
  });
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const attempts = useAutomationQuery(environmentId, {
    op: "attempts",
    factoryId: item.factoryId,
    runId: item.runId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const detail = run.result?.kind === "run" ? run.result : null;
  const matches =
    detail?.control?.revision === item.expectedRevision &&
    detail.control.resultRevision === item.resultRevision;
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Decision evidence">
      <h3 className="font-medium">Evidence for this decision</h3>
      <p className="text-sm">
        Decision revision {item.expectedRevision} · Result revision {item.resultRevision}
      </p>
      {run.error || attempts.error ? <p role="alert">{run.error ?? attempts.error}</p> : null}
      {detail ? (
        <p className="text-sm" role={matches ? "status" : "alert"}>
          {matches
            ? "This decision matches the current run and result revisions."
            : "The run changed. This evidence is current; reload the inbox before deciding on the new revision."}
        </p>
      ) : null}
      {attempts.result?.kind === "attempts" ? (
        <>
          <ul className="space-y-2">
            {attempts.result.items.map((attempt) => (
              <li
                key={attempt.commandId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  {detail?.workflow.steps[attempt.ordinal]?.id ?? `Step ${attempt.ordinal + 1}`} ·
                  Attempt {attempt.attemptNumber + 1} · {attempt.state}
                </span>
                <Button variant="outline" onClick={() => setSelected(attempt.commandId)}>
                  Inspect evidence
                </Button>
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
          factoryId={item.factoryId}
          runId={item.runId}
          commandId={selected}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Review the attempt's checkpoint, confirmed tests, linked T3 diff and central artifacts. A
        completed turn or an inbox mark is not approval.
      </p>
    </section>
  );
}
