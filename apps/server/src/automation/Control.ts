import { machineBearerToken } from "../foundry/MachineCredentials.ts";
import * as MachineAccess from "./MachineAccess.ts";
import type { ReadIdentity } from "./MachineAccess.ts";
import { CommandId, OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import {
  AutomationControlCommand,
  AutomationControlError,
  type AutomationControlSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import { DispatchBinding } from "./Scheduler.ts";

const isControlError = Schema.is(AutomationControlError);
const isWorkerError = Schema.is(WorkerTransport.WorkerTransportError);
const decodeBinding = Schema.decodeUnknownEffect(DispatchBinding);
const decodeCommand = Schema.decodeEffect(AutomationControlCommand, { onExcessProperty: "error" });
const decodeAttempt = Schema.decodeUnknownEffect(DispatchStore.AttemptRequest);
const decodeQuestions = Schema.decodeUnknownEffect(
  Schema.Struct({ questions: Schema.Array(OrchestrationV2UserInputQuestion) }),
);
const isAnswers = Schema.is(Schema.Array(Schema.String));
const fail = (code: AutomationControlError["code"]) => new AutomationControlError({ code });
const mapError = (error: unknown) =>
  isControlError(error)
    ? error
    : isWorkerError(error) && error.reason === "forbidden"
      ? fail("forbidden")
      : fail("unavailable");
export class Control extends Context.Service<
  Control,
  {
    readonly read: (
      request: HttpServerRequest.HttpServerRequest,
      factoryId: string,
      runId: string,
    ) => Effect.Effect<AutomationControlSnapshot, AutomationControlError>;
    readonly readAuthorized: (
      identity: ReadIdentity,
      factoryId: string,
      runId: string,
    ) => Effect.Effect<AutomationControlSnapshot, AutomationControlError>;
    readonly execute: (
      request: HttpServerRequest.HttpServerRequest,
      input: AutomationControlCommand,
    ) => Effect.Effect<AutomationControlSnapshot, AutomationControlError>;
  }
>()("t3/automation/Control") {}

const make = Effect.gen(function* () {
  const machineAccess = yield* Effect.serviceOption(MachineAccess.MachineAccess);
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const store = yield* DispatchStore.DispatchStore;
  const worker = yield* WorkerTransport.WorkerTransport;
  const crypto = yield* Crypto.Crypto;
  const snapshot = Effect.fn("Control.snapshot")(function* (factoryId: string, runId: string) {
    const rows =
      yield* sql<AutomationControlSnapshot>`SELECT r.factory_id AS "factoryId", r.id AS "runId", c.revision, c.result_revision AS "resultRevision", CASE WHEN c.mode='active' THEN d.state ELSE c.mode END AS state,d.reason FROM foundry_automation.runs r JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id JOIN foundry_automation.run_controls c ON c.run_id=r.id WHERE r.factory_id=${factoryId} AND r.id=${runId}`;
    if (!rows[0]) return yield* fail("not_found");
    return rows[0];
  });
  const owned = Effect.fn("Control.owned")(function* (
    identity: ReadIdentity,
    factoryId: string,
    runId: string,
  ) {
    if (identity.factoryIds && !identity.factoryIds.includes(factoryId))
      return yield* fail("forbidden");
    const rows = yield* sql<{
      binding: unknown;
    }>`SELECT d.binding FROM foundry_automation.dispatch_runs d JOIN foundry_automation.runs r ON r.id=d.run_id WHERE r.factory_id=${factoryId} AND r.id=${runId}`;
    if (!rows[0]) return yield* fail("not_found");
    const binding = yield* decodeBinding(rows[0].binding);
    if (
      identity.instanceId !== binding.identity.instanceId ||
      identity.operatorId !== binding.identity.operatorId
    )
      return yield* fail("forbidden");
    return { binding };
  });
  const read = Effect.fn("Control.read")(function* (
    request: HttpServerRequest.HttpServerRequest,
    factoryId: string,
    runId: string,
  ) {
    yield* owned(yield* worker.identityForRead(request), factoryId, runId);
    return yield* snapshot(factoryId, runId);
  }, Effect.mapError(mapError));
  const readAuthorized = Effect.fn("Control.readAuthorized")(function* (
    identity: ReadIdentity,
    factoryId: string,
    runId: string,
  ) {
    yield* owned(identity, factoryId, runId);
    return yield* snapshot(factoryId, runId);
  }, Effect.mapError(mapError));
  const execute = Effect.fn("Control.execute")(function* (
    request: HttpServerRequest.HttpServerRequest,
    raw: AutomationControlCommand,
  ) {
    const input = yield* decodeCommand(raw);
    if (
      Option.isNone(machineAccess) &&
      machineBearerToken(request.headers.authorization) !== undefined
    )
      return yield* fail("forbidden");
    const writer = yield* Option.isSome(machineAccess)
      ? machineAccess.value.write(request, input.factoryId, "automation:control")
      : worker.identityForWrite(request);
    const { binding } = yield* owned(writer, input.factoryId, input.runId);
    if (
      writer.instanceId !== binding.identity.instanceId ||
      writer.operatorId !== binding.identity.operatorId
    )
      return yield* fail("forbidden");
    let selected = binding.identity;
    if (input.action === "answer" && binding.workers) {
      const rows = yield* sql<{
        workerId: string;
      }>`SELECT a.worker_id AS "workerId" FROM foundry_automation.run_questions q JOIN foundry_automation.step_attempts a ON a.run_id=q.run_id AND a.receipt->'receipt'->>'threadId'=q.thread_id WHERE q.run_id=${input.runId} AND q.request_id=${input.requestId} AND NOT EXISTS (SELECT 1 FROM foundry_automation.step_attempts newer WHERE newer.run_id=a.run_id AND newer.ordinal=a.ordinal AND newer.attempt_number>a.attempt_number)`;
      const assigned = binding.workers.find(
        (entry) => entry.identity.deviceId === rows[0]?.workerId,
      );
      if (!assigned) return yield* fail("conflict");
      selected = assigned.identity;
    }
    const identity =
      input.action === "resume" || input.action === "retry" || input.action === "answer"
        ? yield* worker.authorize(request, selected)
        : input.action === "cancel"
          ? yield* worker.authorize(request, selected).pipe(Effect.orElseSucceed(() => selected))
          : selected;
    const matches = (
      previous: WorkerTransport.WorkerIdentity,
      current: WorkerTransport.WorkerIdentity,
    ) =>
      current.instanceId === previous.instanceId &&
      current.operatorId === previous.operatorId &&
      current.deviceId === previous.deviceId &&
      current.environmentId === previous.environmentId &&
      current.deviceGeneration === previous.deviceGeneration &&
      current.accessGeneration === previous.accessGeneration &&
      current.automationGeneration === previous.automationGeneration;
    if (!matches(selected, identity)) return yield* fail("forbidden");
    const workers =
      binding.workers && (input.action === "resume" || input.action === "cancel")
        ? yield* Effect.forEach(binding.workers, (entry) =>
            Effect.gen(function* () {
              const refreshed = yield* worker
                .authorize(request, entry.identity)
                .pipe(
                  Effect.catch((error) =>
                    input.action === "cancel" ? Effect.succeed(entry.identity) : Effect.fail(error),
                  ),
                );
              if (!matches(entry.identity, refreshed)) return yield* fail("forbidden");
              return { ...entry, identity: refreshed };
            }),
          )
        : binding.workers;
    const refreshedBinding = {
      ...binding,
      identity: input.action === "answer" ? binding.identity : identity,
      ...(workers ? { workers } : {}),
    };
    const digest = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(input.commandId)),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT worker_id FROM foundry_automation.dispatch_workers WHERE worker_id=${binding.identity.deviceId} FOR UPDATE`;
        yield* sql`SELECT run_id FROM foundry_automation.run_controls WHERE run_id=${input.runId} FOR UPDATE`;
        const previous = yield* sql<{
          same: boolean;
          receipt: AutomationControlSnapshot | null;
        }>`SELECT c.kind='run.control' AND c.payload=${sql.json(input)}::jsonb AS same,r.receipt FROM foundry_automation.commands c LEFT JOIN foundry_automation.control_commands r ON r.id=c.id WHERE c.id=${input.commandId}`;
        if (previous[0]) {
          if (!previous[0].same || !previous[0].receipt) return yield* fail("conflict");
          return previous[0].receipt;
        }
        const handedOff =
          yield* sql`SELECT id FROM foundry_automation.work_item_handoffs WHERE run_id=${input.runId}`;
        if (handedOff.length) return yield* fail("invalid_transition");
        const current = yield* snapshot(input.factoryId, input.runId);
        if (current.revision !== input.expectedRevision) return yield* fail("conflict");
        const run = yield* store.read(input.factoryId, input.runId);
        const latest = [
          ...new Map(run.attempts.map((attempt) => [attempt.ordinal, attempt])).values(),
        ];
        const active = latest.findLast((attempt) => attempt.state !== "succeeded");
        const terminal = current.state === "succeeded" || current.state === "cancelled";
        yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${input.commandId},'run.control',${sql.json(input)})`;
        if (input.action === "pause") {
          if (terminal || current.state === "cancel_requested" || current.state === "failed")
            return yield* fail("invalid_transition");
          yield* sql`UPDATE foundry_automation.run_controls SET mode='paused' WHERE run_id=${input.runId}`;
        } else if (input.action === "resume") {
          if (current.state !== "paused" && current.state !== "waiting")
            return yield* fail("invalid_transition");
          if (
            identity.deviceGeneration !== binding.identity.deviceGeneration ||
            identity.accessGeneration !== binding.identity.accessGeneration ||
            identity.automationGeneration !== binding.identity.automationGeneration
          )
            return yield* fail("forbidden");
          yield* sql`UPDATE foundry_automation.dispatch_runs SET binding=${sql.json(refreshedBinding)},state='running',reason=NULL WHERE run_id=${input.runId}`;
          yield* sql`UPDATE foundry_automation.run_controls SET mode='active' WHERE run_id=${input.runId}`;
        } else if (input.action === "cancel") {
          if (terminal) return yield* fail("invalid_transition");
          if (
            identity.deviceGeneration !== binding.identity.deviceGeneration ||
            identity.accessGeneration !== binding.identity.accessGeneration ||
            identity.automationGeneration !== binding.identity.automationGeneration
          )
            return yield* fail("forbidden");
          yield* sql`UPDATE foundry_automation.run_controls SET mode='cancel_requested' WHERE run_id=${input.runId}`;
          yield* sql`UPDATE foundry_automation.dispatch_runs SET binding=${sql.json(refreshedBinding)},state='waiting',reason='cancel_requested' WHERE run_id=${input.runId}`;
        } else if (input.action === "retry") {
          if (
            run.workflow.execution ||
            run.workflow.v4 ||
            current.state !== "failed" ||
            !active ||
            active.state !== "failed"
          )
            return yield* fail("invalid_transition");
          if (!DispatchStore.writerEnded(active.result)) return yield* fail("writer_not_ended");
          if (
            identity.deviceGeneration !== binding.identity.deviceGeneration ||
            identity.accessGeneration !== binding.identity.accessGeneration ||
            identity.automationGeneration !== binding.identity.automationGeneration
          )
            return yield* fail("forbidden");
          const commandId = CommandId.make(`automation:retry:${digest}`);
          const launch = yield* decodeAttempt(active.request);
          const { previousExecution: _previousExecution, ...retry } = launch;
          yield* sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,attempt_number,request) VALUES(${commandId},${input.runId},${active.ordinal},${(active.attemptNumber ?? 0) + 1},${sql.json({ ...retry, commandId })})`;
          yield* sql`INSERT INTO foundry_automation.dispatch_outbox(command_id) VALUES(${commandId})`;
          yield* sql`UPDATE foundry_automation.dispatch_runs SET binding=${sql.json(refreshedBinding)},state='running',reason=NULL WHERE run_id=${input.runId}`;
          yield* sql`UPDATE foundry_automation.run_controls SET mode='active',result_revision=result_revision+1 WHERE run_id=${input.runId}`;
        } else if (input.action === "answer") {
          if (
            terminal ||
            current.state === "cancel_requested" ||
            current.resultRevision !== input.resultRevision
          )
            return yield* fail("conflict");
          const questions = yield* sql<{
            payload: unknown;
          }>`SELECT q.payload FROM foundry_automation.run_questions q JOIN LATERAL (SELECT a.state,a.receipt,a.result FROM foundry_automation.step_attempts a WHERE a.run_id=q.run_id AND a.receipt->'receipt'->>'threadId'=q.thread_id AND NOT EXISTS (SELECT 1 FROM foundry_automation.step_attempts newer WHERE newer.run_id=a.run_id AND newer.ordinal=a.ordinal AND newer.attempt_number>a.attempt_number) ORDER BY a.ordinal DESC,a.attempt_number DESC LIMIT 1) a ON true WHERE q.run_id=${input.runId} AND q.request_id=${input.requestId} AND q.status='pending' AND q.payload->'request'->>'kind'='user_input' AND q.payload->'request'->>'status'='pending' AND q.payload->'request'->'responseCapability'->>'type' IN ('live','message') AND a.state NOT IN ('failed','succeeded') AND a.receipt->'receipt'->>'threadId'=q.thread_id AND a.result->'execution'->'lifecycle'->>'writerEnded' IS DISTINCT FROM 'true'`;
          if (!questions[0]) return yield* fail("conflict");
          const questionPayload = yield* decodeQuestions(questions[0].payload);
          if (
            Object.keys(input.answers).some(
              (id) => !questionPayload.questions.some((q) => q.id === id),
            )
          )
            return yield* fail("invalid_transition");
          for (const question of questionPayload.questions) {
            const value = input.answers[question.id];
            if (value !== undefined && typeof value !== "string" && !isAnswers(value))
              return yield* fail("invalid_transition");
            const values = typeof value === "string" ? [value] : isAnswers(value) ? value : [];
            if (
              (question.required !== false && !values.some((answer) => answer.trim().length > 0)) ||
              (!question.multiSelect && values.length > 1) ||
              (question.allowCustomAnswer === false &&
                values.some(
                  (answer) =>
                    !question.options.some((option) => answer === (option.value ?? option.label)),
                ))
            )
              return yield* fail("invalid_transition");
          }
          const rows =
            yield* sql`UPDATE foundry_automation.run_questions SET answer=${sql.json({ commandId: input.commandId, answers: input.answers, identity })},status='answered' WHERE run_id=${input.runId} AND request_id=${input.requestId} AND status='pending' RETURNING request_id`;
          if (!rows.length) return yield* fail("conflict");
        } else if (input.action === "approve" || input.action === "reject") {
          if (
            terminal ||
            current.state === "cancel_requested" ||
            current.resultRevision !== input.resultRevision
          )
            return yield* fail("conflict");
          const ordinal = run.workflow.steps.findIndex((step) => step.id === input.stepId);
          const step = run.workflow.steps[ordinal];
          if (
            !step ||
            (step.kind !== "approval" && step.kind !== "publish") ||
            (run.workflow.v4
              ? !run.v4State?.nodes.some(
                  (node) => node.ordinal === ordinal && node.status === "ready",
                )
              : run.workflow.execution
                ? !step.dependsOn.every((id) => {
                    const dependency = run.workflow.steps.findIndex(
                      (candidate) => candidate.id === id,
                    );
                    return latest.some(
                      (attempt) => attempt.ordinal === dependency && attempt.state === "succeeded",
                    );
                  })
                : latest.some((a) => a.ordinal < ordinal && a.state !== "succeeded") ||
                  latest.filter((a) => a.ordinal < ordinal).length !== ordinal)
          )
            return yield* fail("invalid_transition");
          yield* sql`INSERT INTO foundry_automation.run_decisions(command_id,run_id,step_id,revision,result_revision,approved) VALUES(${input.commandId},${input.runId},${input.stepId},${current.revision + 1},${current.resultRevision},${input.action === "approve"})`;
        }
        yield* sql`UPDATE foundry_automation.run_controls SET revision=revision+1 WHERE run_id=${input.runId}`;
        const receipt = yield* snapshot(input.factoryId, input.runId);
        yield* sql`INSERT INTO foundry_automation.control_commands(id,receipt) VALUES(${input.commandId},${sql.json(receipt)})`;
        return receipt;
      }),
    );
  }, Effect.mapError(mapError));
  return Control.of({ read, readAuthorized, execute });
});
export const layer = Layer.effect(Control, make);
