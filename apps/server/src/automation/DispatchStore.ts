import {
  FoundryWorkerExecution,
  FoundryWorkerLaunchInput,
  type FoundryArchiveEvent,
  type StartAutomationRun,
  type AutomationRun,
  type AutomationWorkflowVersion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as Factories from "./Factories.ts";
import * as Workflows from "./Workflows.ts";

export class DispatchError extends Schema.TaggedError<DispatchError>()("DispatchError", {
  reason: Schema.Literals(["not_found", "conflict", "stale_claim", "invalid_step", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Automation dispatch failed (${this.reason}).`;
  }
}
const isDispatchError = Schema.is(DispatchError);
const operationError = (cause: unknown) =>
  isDispatchError(cause) ? cause : new DispatchError({ reason: "unavailable", cause });
export const AttemptRequest = FoundryWorkerLaunchInput;
const ResultExecution = Schema.Struct({ execution: FoundryWorkerExecution });
const decodeResultExecution = Schema.decodeUnknownOption(ResultExecution);
const isPublish = Schema.is(Schema.Struct({ kind: Schema.Literal("publish") }));
const isApproval = Schema.is(Schema.Struct({ kind: Schema.Literal("approval") }));
export const writerEnded = (result: unknown): boolean => {
  const decoded = decodeResultExecution(result);
  if (decoded._tag === "None") return false;
  const execution = decoded.value.execution;
  return (
    execution.lifecycle?.writerEnded === true &&
    (execution.lifecycle.manifest === null ||
      (execution.lifecycle.manifest.generation === execution.lifecycle.generation &&
        execution.lifecycle.manifest.runId === execution.run.id))
  );
};
export type DispatchState = "running" | "waiting" | "failed" | "succeeded";
export interface DispatchAttempt {
  readonly commandId: string;
  readonly ordinal: number;
  readonly attemptNumber?: number;
  readonly request: unknown;
  readonly state: "pending" | "running" | "waiting" | "finalizing" | "failed" | "succeeded";
  readonly reason: string | null;
  readonly receipt: unknown | null;
  readonly result: unknown | null;
}
export interface DispatchRun {
  readonly run: AutomationRun;
  readonly workflow: AutomationWorkflowVersion;
  readonly workerId: string;
  readonly binding: unknown;
  readonly state: DispatchState;
  readonly reason: string | null;
  readonly attempts: ReadonlyArray<DispatchAttempt>;
  readonly mode?: "active" | "paused" | "cancel_requested" | "cancelled";
  readonly revision?: number;
  readonly resultRevision?: number;
}
export interface DispatchClaim extends DispatchRun {
  readonly owner: string;
  readonly generation: number;
}
export class DispatchStore extends Context.Service<
  DispatchStore,
  {
    readonly startManual: (
      input: typeof StartAutomationRun.Type,
      workerId: string,
      binding: unknown,
      identity: unknown,
    ) => Effect.Effect<DispatchRun, DispatchError>;
    readonly startTriggered: (
      input: typeof StartAutomationRun.Type,
      workerId: string,
      binding: unknown,
      admission: { eventId: string; bindingId: string; generation: number; identity: unknown },
    ) => Effect.Effect<DispatchRun, DispatchError>;
    readonly completePublish: (
      claim: DispatchClaim,
      ordinal: number,
      commandId: string,
      result: { number: number; url: string; commitSha: string; operationKey: string },
    ) => Effect.Effect<boolean, DispatchError>;
    readonly enroll: (input: {
      readonly factoryId: string;
      readonly runId: string;
      readonly workerId: string;
      readonly binding: unknown;
    }) => Effect.Effect<DispatchRun, DispatchError>;
    readonly read: (factoryId: string, runId: string) => Effect.Effect<DispatchRun, DispatchError>;
    readonly claimNext: (input: {
      readonly workerId: string;
      readonly owner: string;
      readonly leaseMillis: number;
    }) => Effect.Effect<DispatchClaim | null, DispatchError>;
    readonly prepare: (
      claim: DispatchClaim,
      input: {
        readonly ordinal: number;
        readonly commandId: string;
        readonly request: unknown;
      },
    ) => Effect.Effect<DispatchAttempt, DispatchError>;
    readonly record: (
      claim: DispatchClaim,
      input: {
        readonly commandId: string;
        readonly state: Exclude<DispatchAttempt["state"], "pending">;
        readonly reason: string | null;
        readonly receipt: unknown | null;
        readonly result: unknown | null;
      },
    ) => Effect.Effect<boolean, DispatchError>;
    readonly wait: (claim: DispatchClaim, reason: string) => Effect.Effect<boolean, DispatchError>;
    readonly archiveCursor: (commandId: string) => Effect.Effect<number, DispatchError>;
    readonly projectQuestions: (
      claim: DispatchClaim,
      commandId: string,
      events: ReadonlyArray<FoundryArchiveEvent>,
    ) => Effect.Effect<void, DispatchError>;
    readonly answers: (
      runId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ requestId: string; threadId: string; answer: unknown }>,
      DispatchError
    >;
    readonly answerDelivered: (
      runId: string,
      requestId: string,
    ) => Effect.Effect<void, DispatchError>;
    readonly permitted: (runId: string) => Effect.Effect<boolean, DispatchError>;
    readonly admission: (
      runId: string,
      commandId: string,
      identity: unknown,
    ) => Effect.Effect<void, DispatchError>;
    readonly canLaunch: (claim: DispatchClaim) => Effect.Effect<boolean, DispatchError>;
    readonly beginDelivery: (
      claim: DispatchClaim,
      commandId: string,
    ) => Effect.Effect<boolean, DispatchError>;
    readonly completeApproval: (
      claim: DispatchClaim,
      ordinal: number,
      commandId: string,
    ) => Effect.Effect<boolean, DispatchError>;
    readonly approved: (
      claim: DispatchClaim,
      stepId: string,
    ) => Effect.Effect<boolean, DispatchError>;
    readonly confirmCancel: (claim: DispatchClaim) => Effect.Effect<boolean, DispatchError>;
    readonly release: (claim: DispatchClaim) => Effect.Effect<void, DispatchError>;
  }
>()("t3/automation/DispatchStore") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const workflows = yield* Workflows.Workflows;
  const factories = yield* Factories.Factories;
  const attempts = Effect.fn("DispatchStore.attempts")(function* (runId: string) {
    return yield* sql<DispatchAttempt>`SELECT command_id AS "commandId",ordinal,attempt_number AS "attemptNumber",request,state,reason,receipt,result FROM foundry_automation.step_attempts WHERE run_id=${runId} ORDER BY ordinal,attempt_number`;
  });
  const read = Effect.fn("DispatchStore.read")(function* (factoryId: string, runId: string) {
    const run = yield* workflows.readRun(factoryId, runId);
    const rows = yield* sql<{
      workerId: string;
      binding: unknown;
      state: DispatchState;
      reason: string | null;
      mode: "active" | "paused" | "cancel_requested" | "cancelled";
      revision: number;
      resultRevision: number;
    }>`SELECT d.worker_id AS "workerId",d.binding,d.state,d.reason,c.mode,c.revision,c.result_revision AS "resultRevision" FROM foundry_automation.dispatch_runs d JOIN foundry_automation.run_controls c ON c.run_id=d.run_id WHERE d.run_id=${runId}`;
    if (!rows[0]) return yield* new DispatchError({ reason: "not_found" });
    return {
      ...rows[0],
      run,
      workflow: yield* workflows.readVersion(factoryId, run.workflowVersionId),
      attempts: yield* attempts(runId),
    };
  }, Effect.mapError(operationError));
  const enroll = Effect.fn("DispatchStore.enroll")(function* (
    input: Parameters<DispatchStore["Service"]["enroll"]>[0],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const run = yield* workflows.readRun(input.factoryId, input.runId);
        const previous = yield* sql<{
          same: boolean;
        }>`SELECT worker_id=${input.workerId} AND binding=${sql.json(input.binding)}::jsonb AS same FROM foundry_automation.dispatch_runs WHERE run_id=${input.runId}`;
        if (previous.length) {
          if (!previous[0]?.same) return yield* new DispatchError({ reason: "conflict" });
          return yield* read(input.factoryId, input.runId);
        }
        yield* factories.withStartEligibility(
          input.factoryId,
          run.workItemId,
          Effect.gen(function* () {
            yield* sql`INSERT INTO foundry_automation.dispatch_runs(run_id,worker_id,binding) VALUES(${input.runId},${input.workerId},${sql.json(input.binding)}) ON CONFLICT DO NOTHING`;
            yield* sql`INSERT INTO foundry_automation.run_controls(run_id) VALUES(${input.runId}) ON CONFLICT DO NOTHING`;
            yield* sql`INSERT INTO foundry_automation.dispatch_workers(worker_id) VALUES(${input.workerId}) ON CONFLICT DO NOTHING`;
          }).pipe(
            Effect.mapError(
              (cause) => new Factories.AutomationError({ reason: "unavailable", cause }),
            ),
          ),
        );
        const saved = yield* sql<{
          same: boolean;
        }>`SELECT worker_id=${input.workerId} AND binding=${sql.json(input.binding)}::jsonb AS same FROM foundry_automation.dispatch_runs WHERE run_id=${input.runId}`;
        if (!saved[0]?.same) return yield* new DispatchError({ reason: "conflict" });
        return yield* read(input.factoryId, input.runId);
      }),
    );
  }, Effect.mapError(operationError));
  const claimNext = Effect.fn("DispatchStore.claimNext")(function* (
    input: Parameters<DispatchStore["Service"]["claimNext"]>[0],
  ) {
    if (
      !Number.isSafeInteger(input.leaseMillis) ||
      input.leaseMillis < 1 ||
      input.leaseMillis > 60_000 ||
      !input.owner
    )
      return yield* new DispatchError({ reason: "conflict" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const slots = yield* sql<{
          runId: string | null;
        }>`SELECT run_id AS "runId" FROM foundry_automation.dispatch_workers WHERE worker_id=${input.workerId} AND lease_until<=clock_timestamp() FOR UPDATE SKIP LOCKED`;
        if (!slots[0]) return null;
        const held =
          yield* sql`SELECT h.id FROM foundry_automation.work_item_handoffs h JOIN foundry_automation.dispatch_runs d ON d.run_id=h.run_id WHERE d.worker_id=${input.workerId} AND h.state<>'returned'`;
        if (held.length) return null;
        let runId = slots[0].runId;
        if (!runId) {
          const queued = yield* sql<{
            runId: string;
          }>`SELECT d.run_id AS "runId" FROM foundry_automation.dispatch_runs d WHERE d.worker_id=${input.workerId} AND d.state IN ('running','waiting') AND NOT EXISTS (SELECT 1 FROM foundry_automation.work_item_handoffs h WHERE h.run_id=d.run_id) ORDER BY d.enrolled_at,d.run_id LIMIT 1`;
          runId = queued[0]?.runId ?? null;
        }
        if (!runId) return null;
        const runs = yield* sql<{
          factoryId: string;
          state: DispatchState;
        }>`SELECT r.factory_id AS "factoryId",d.state FROM foundry_automation.runs r JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id WHERE r.id=${runId}`;
        if (!runs[0] || runs[0].state === "failed" || runs[0].state === "succeeded") return null;
        const claimed = yield* sql<{
          generation: number;
        }>`UPDATE foundry_automation.dispatch_workers SET run_id=${runId},claim_owner=${input.owner},claim_generation=claim_generation+1,lease_until=clock_timestamp()+${input.leaseMillis}*interval '1 millisecond' WHERE worker_id=${input.workerId} RETURNING claim_generation AS generation`;
        return {
          ...(yield* read(runs[0].factoryId, runId)),
          owner: input.owner,
          generation: claimed[0]!.generation,
        };
      }),
    );
  }, Effect.mapError(operationError));
  const lockClaim = Effect.fn("DispatchStore.lockClaim")(function* (claim: DispatchClaim) {
    const rows =
      yield* sql`SELECT worker_id FROM foundry_automation.dispatch_workers WHERE worker_id=${claim.workerId} AND run_id=${claim.run.id} AND claim_owner=${claim.owner} AND claim_generation=${claim.generation} AND lease_until>clock_timestamp() FOR UPDATE`;
    return rows.length === 1;
  });
  const prepare = Effect.fn("DispatchStore.prepare")(function* (
    claim: DispatchClaim,
    input: Parameters<DispatchStore["Service"]["prepare"]>[1],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim))) return yield* new DispatchError({ reason: "stale_claim" });
        const existing = [
          ...new Map((yield* attempts(claim.run.id)).map((a) => [a.ordinal, a])).values(),
        ];
        const old = existing.find((a) => a.ordinal === input.ordinal);
        if (old) {
          const matches = yield* sql<{
            same: boolean;
          }>`SELECT command_id=${input.commandId} AND request=${sql.json(input.request)}::jsonb AS same FROM foundry_automation.step_attempts WHERE run_id=${claim.run.id} AND ordinal=${input.ordinal}`;
          if (!matches[0]?.same) return yield* new DispatchError({ reason: "conflict" });
          return old;
        }
        const run = yield* read(claim.run.factoryId, claim.run.id);
        if (
          (run.mode !== undefined && run.mode !== "active") ||
          run.state === "failed" ||
          run.state === "succeeded" ||
          input.ordinal !== existing.length ||
          !run.workflow.steps[input.ordinal] ||
          existing.some((a) => a.state !== "succeeded")
        )
          return yield* new DispatchError({ reason: "invalid_step" });
        if (claim.resultRevision !== undefined && run.resultRevision !== claim.resultRevision)
          return yield* new DispatchError({ reason: "stale_claim" });
        const previousWorker = existing.findLast((entry) => entry.result !== null)?.ordinal ?? -1;
        for (const step of run.workflow.steps.slice(previousWorker + 1, input.ordinal + 1)) {
          if (step.kind === "approval" && !(yield* approved(claim, step.id)))
            return yield* new DispatchError({ reason: "invalid_step" });
        }
        yield* sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request) VALUES(${input.commandId},${claim.run.id},${input.ordinal},${sql.json(input.request)})`;
        if (!isPublish(input.request))
          yield* sql`INSERT INTO foundry_automation.dispatch_outbox(command_id) VALUES(${input.commandId})`;
        yield* sql`UPDATE foundry_automation.dispatch_runs SET state='running',reason=NULL WHERE run_id=${claim.run.id}`;
        return (yield* attempts(claim.run.id)).findLast((a) => a.ordinal === input.ordinal)!;
      }),
    );
  }, Effect.mapError(operationError));
  const record = Effect.fn("DispatchStore.record")(function* (
    claim: DispatchClaim,
    input: Parameters<DispatchStore["Service"]["record"]>[1],
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim))) return false;
        const rows = yield* sql<
          DispatchAttempt & { receiptMatches: boolean; resultMatches: boolean }
        >`SELECT command_id AS "commandId",ordinal,request,state,reason,receipt,result, (receipt IS NULL OR ${input.receipt === null} OR receipt=${sql.json(input.receipt)}::jsonb) AS "receiptMatches", (result=${sql.json(input.result)}::jsonb OR (result IS NULL AND ${input.result === null})) AS "resultMatches" FROM foundry_automation.step_attempts WHERE command_id=${input.commandId} AND run_id=${claim.run.id}`;
        const old = rows[0];
        if (!old) return yield* new DispatchError({ reason: "not_found" });
        if (!old.receiptMatches) return yield* new DispatchError({ reason: "conflict" });
        if (old.state === "succeeded" || old.state === "failed") {
          if (old.state !== input.state || old.reason !== input.reason || !old.resultMatches)
            return yield* new DispatchError({ reason: "conflict" });
          return true;
        }
        if (!old.resultMatches && input.result !== null)
          yield* sql`UPDATE foundry_automation.run_controls SET revision=revision+1,result_revision=result_revision+1 WHERE run_id=${claim.run.id}`;
        yield* sql`UPDATE foundry_automation.step_attempts SET state=${input.state},reason=${input.reason},receipt=COALESCE(receipt,NULLIF(${sql.json(input.receipt)}::jsonb,'null'::jsonb)),result=NULLIF(${sql.json(input.result)}::jsonb,'null'::jsonb) WHERE command_id=${input.commandId}`;
        yield* sql`UPDATE foundry_automation.dispatch_outbox SET state=CASE WHEN ${input.state} IN ('succeeded','failed') THEN 'confirmed' WHEN ${input.receipt !== null || old.receipt !== null} THEN 'delivered' ELSE state END WHERE command_id=${input.commandId}`;
        const workflow = yield* workflows.readVersion(
          claim.run.factoryId,
          claim.run.workflowVersionId,
        );
        const controls = yield* sql<{
          mode: string;
        }>`SELECT mode FROM foundry_automation.run_controls WHERE run_id=${claim.run.id}`;
        const cancelling = controls[0]?.mode === "cancel_requested";
        const state: DispatchState = cancelling
          ? "waiting"
          : input.state === "failed"
            ? "failed"
            : input.state === "succeeded" && old.ordinal === workflow.steps.length - 1
              ? "succeeded"
              : input.state === "waiting" || input.state === "finalizing"
                ? "waiting"
                : "running";
        if (state === "failed" || state === "succeeded")
          yield* sql`UPDATE foundry_automation.run_controls SET mode='active' WHERE run_id=${claim.run.id} AND mode='paused'`;
        yield* sql`UPDATE foundry_automation.dispatch_runs SET state=${state},reason=${cancelling ? "cancel_requested" : input.reason} WHERE run_id=${claim.run.id}`;
        if (state === "succeeded")
          yield* sql`UPDATE foundry_automation.dispatch_workers SET run_id=NULL,claim_owner=NULL,lease_until='-infinity' WHERE worker_id=${claim.workerId}`;
        return true;
      }),
    );
  }, Effect.mapError(operationError));
  const wait = Effect.fn("DispatchStore.wait")(function* (claim: DispatchClaim, reason: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim))) return false;
        const rows =
          yield* sql`UPDATE foundry_automation.dispatch_runs SET state='waiting',reason=${reason} WHERE run_id=${claim.run.id} AND state IN ('running','waiting') RETURNING run_id`;
        return rows.length === 1;
      }),
    );
  }, Effect.mapError(operationError));
  const release = Effect.fn("DispatchStore.release")(function* (claim: DispatchClaim) {
    yield* sql`UPDATE foundry_automation.dispatch_workers SET claim_owner=NULL,lease_until='-infinity' WHERE worker_id=${claim.workerId} AND run_id=${claim.run.id} AND claim_owner=${claim.owner} AND claim_generation=${claim.generation}`;
  }, Effect.mapError(operationError));
  const archiveCursor = Effect.fn("DispatchStore.archiveCursor")(function* (commandId: string) {
    const rows = yield* sql<{
      cursor: number;
    }>`SELECT archive_cursor AS cursor FROM foundry_automation.step_attempts WHERE command_id=${commandId}`;
    return rows[0]?.cursor ?? 0;
  }, Effect.mapError(operationError));
  const projectQuestions = Effect.fn("DispatchStore.projectQuestions")(function* (
    claim: DispatchClaim,
    commandId: string,
    events: ReadonlyArray<FoundryArchiveEvent>,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim))) return;
        let cursor = yield* archiveCursor(commandId);
        let questionsChanged = false;
        for (const entry of events) {
          if (entry.sequence <= cursor) continue;
          if (entry.sequence !== cursor + 1)
            return yield* new DispatchError({ reason: "conflict" });
          const event = entry.event;
          if (event.type === "runtime-request.updated" && event.payload.kind === "user_input") {
            const status = event.payload.status === "pending" ? "pending" : "resolved";
            const changed =
              yield* sql`INSERT INTO foundry_automation.run_questions(run_id,request_id,thread_id,payload,status,source_sequence) VALUES(${claim.run.id},${event.payload.id},${event.threadId},${sql.json({ request: event.payload })},${status},${entry.sourceSequence}) ON CONFLICT(run_id,request_id) DO UPDATE SET payload=foundry_automation.run_questions.payload || EXCLUDED.payload,status=CASE WHEN foundry_automation.run_questions.status='answered' AND EXCLUDED.status='pending' THEN 'answered' ELSE EXCLUDED.status END,source_sequence=EXCLUDED.source_sequence WHERE foundry_automation.run_questions.source_sequence<EXCLUDED.source_sequence RETURNING request_id`;
            questionsChanged ||= changed.length > 0;
          }
          if (event.type === "turn-item.updated" && event.payload.type === "user_input_request") {
            const changed =
              yield* sql`INSERT INTO foundry_automation.run_questions(run_id,request_id,thread_id,payload,status,source_sequence) VALUES(${claim.run.id},${event.payload.requestId},${event.threadId},${sql.json({ questions: event.payload.questions })},'pending',${entry.sourceSequence}) ON CONFLICT(run_id,request_id) DO UPDATE SET payload=foundry_automation.run_questions.payload || EXCLUDED.payload,source_sequence=EXCLUDED.source_sequence WHERE foundry_automation.run_questions.source_sequence<EXCLUDED.source_sequence RETURNING request_id`;
            questionsChanged ||= changed.length > 0;
          }
          cursor = entry.sequence;
        }
        if (questionsChanged)
          yield* sql`UPDATE foundry_automation.run_controls SET revision=revision+1 WHERE run_id=${claim.run.id}`;
        yield* sql`UPDATE foundry_automation.step_attempts SET archive_cursor=${cursor} WHERE command_id=${commandId}`;
      }),
    );
  }, Effect.mapError(operationError));
  const answers = Effect.fn("DispatchStore.answers")(function* (runId: string) {
    return yield* sql<{
      requestId: string;
      threadId: string;
      answer: unknown;
    }>`SELECT request_id AS "requestId",thread_id AS "threadId",answer FROM foundry_automation.run_questions WHERE run_id=${runId} AND status='answered' AND answer->>'delivered' IS DISTINCT FROM 'true' ORDER BY request_id LIMIT 20`;
  }, Effect.mapError(operationError));
  const answerDelivered = Effect.fn("DispatchStore.answerDelivered")(function* (
    runId: string,
    requestId: string,
  ) {
    yield* sql`UPDATE foundry_automation.run_questions SET answer=answer || '{"delivered":true}'::jsonb WHERE run_id=${runId} AND request_id=${requestId}`;
  }, Effect.mapError(operationError));
  const permitted = Effect.fn("DispatchStore.permitted")(function* (runId: string) {
    return (
      (yield* sql`SELECT run_id FROM foundry_automation.manual_admissions WHERE run_id=${runId} UNION SELECT t.run_id FROM foundry_automation.trigger_admissions t JOIN foundry_automation.unattended_grants g ON g.binding_id=t.binding_id AND g.generation=t.generation AND g.enabled WHERE t.run_id=${runId} UNION SELECT t.run_id FROM foundry_automation.trigger_admissions t JOIN foundry_automation.run_controls c ON c.run_id=t.run_id JOIN foundry_automation.dispatch_runs d ON d.run_id=t.run_id WHERE t.run_id=${runId} AND c.mode='cancel_requested' AND d.binding->'identity' ? 'clientSessionId' AND d.binding->'identity' ? 'foundrySessionHash' AND NOT (d.binding->'identity' ? 'authority')`)
        .length === 1
    );
  }, Effect.mapError(operationError));
  const admission = Effect.fn("DispatchStore.admission")(function* (
    runId: string,
    commandId: string,
    identity: unknown,
  ) {
    yield* sql`INSERT INTO foundry_automation.manual_admissions(run_id,command_id,identity) VALUES(${runId},${commandId},${sql.json(identity)}) ON CONFLICT DO NOTHING`;
  }, Effect.mapError(operationError));
  const canLaunch = Effect.fn("DispatchStore.canLaunch")(function* (claim: DispatchClaim) {
    return (
      (yield* sql`SELECT c.run_id FROM foundry_automation.run_controls c JOIN foundry_automation.dispatch_workers w ON w.run_id=c.run_id WHERE c.run_id=${claim.run.id} AND c.mode='active' AND w.claim_owner=${claim.owner} AND w.claim_generation=${claim.generation} AND w.lease_until>clock_timestamp() AND NOT EXISTS (SELECT 1 FROM foundry_automation.work_item_handoffs h JOIN foundry_automation.dispatch_runs d ON d.run_id=h.run_id WHERE h.run_id=c.run_id OR (d.worker_id=w.worker_id AND h.state<>'returned'))`)
        .length === 1
    );
  }, Effect.mapError(operationError));
  const beginDelivery = Effect.fn("DispatchStore.beginDelivery")(function* (
    claim: DispatchClaim,
    commandId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim)) || !(yield* canLaunch(claim))) return false;
        const current = yield* read(claim.run.factoryId, claim.run.id);
        const attempt = current.attempts.find((entry) => entry.commandId === commandId);
        if (!attempt) return false;
        const previousWorker =
          current.attempts.findLast(
            (entry) => entry.ordinal < attempt.ordinal && entry.result !== null,
          )?.ordinal ?? -1;
        for (const step of current.workflow.steps.slice(previousWorker + 1, attempt.ordinal)) {
          if (step.kind === "approval" && !(yield* approved(claim, step.id))) return false;
        }
        yield* sql`UPDATE foundry_automation.dispatch_outbox SET state='sending' WHERE command_id=${commandId} AND state='pending'`;
        return true;
      }),
    );
  }, Effect.mapError(operationError));
  const approved = Effect.fn("DispatchStore.approved")(function* (
    claim: DispatchClaim,
    stepId: string,
  ) {
    return (
      (yield* sql`SELECT d.command_id FROM foundry_automation.run_decisions d JOIN foundry_automation.run_controls c ON c.run_id=d.run_id WHERE d.run_id=${claim.run.id} AND d.step_id=${stepId} AND d.approved AND d.result_revision=c.result_revision AND d.revision=(SELECT max(latest.revision) FROM foundry_automation.run_decisions latest WHERE latest.run_id=d.run_id AND latest.step_id=d.step_id)`)
        .length === 1
    );
  }, Effect.mapError(operationError));
  const completeApproval = Effect.fn("DispatchStore.completeApproval")(function* (
    claim: DispatchClaim,
    ordinal: number,
    commandId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim)) || !(yield* canLaunch(claim))) return false;
        const current = yield* read(claim.run.factoryId, claim.run.id);
        const step = current.workflow.steps[ordinal];
        if (step?.kind !== "approval" || !(yield* approved(claim, step.id))) return false;
        if (claim.resultRevision !== undefined && current.resultRevision !== claim.resultRevision)
          return false;
        const attempt = yield* prepare(claim, {
          ordinal,
          commandId,
          request: { kind: "approval" },
        });
        return yield* record(claim, {
          commandId: attempt.commandId,
          state: "succeeded",
          reason: null,
          receipt: null,
          result: null,
        });
      }),
    );
  }, Effect.mapError(operationError));
  const completePublish = Effect.fn("DispatchStore.completePublish")(function* (
    claim: DispatchClaim,
    ordinal: number,
    commandId: string,
    result: { number: number; url: string; commitSha: string; operationKey: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim)) || !(yield* canLaunch(claim))) return false;
        const current = yield* read(claim.run.factoryId, claim.run.id);
        const step = current.workflow.steps[ordinal];
        if (
          step?.kind !== "publish" ||
          !(yield* approved(claim, step.id)) ||
          current.resultRevision !== claim.resultRevision
        )
          return false;
        const attempt = yield* prepare(claim, { ordinal, commandId, request: { kind: "publish" } });
        return yield* record(claim, {
          commandId: attempt.commandId,
          state: "succeeded",
          reason: null,
          receipt: null,
          result: { publish: result },
        });
      }),
    );
  }, Effect.mapError(operationError));
  const confirmCancel = Effect.fn("DispatchStore.confirmCancel")(function* (claim: DispatchClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* lockClaim(claim))) return false;
        const saved = yield* read(claim.run.factoryId, claim.run.id);
        if (saved.mode !== "cancel_requested") return false;
        for (const attempt of saved.attempts) {
          if (writerEnded(attempt.result) || isApproval(attempt.request)) continue;
          const undelivered =
            yield* sql`SELECT command_id FROM foundry_automation.dispatch_outbox WHERE command_id=${attempt.commandId} AND state='pending'`;
          if (!undelivered.length) return false;
        }
        yield* sql`UPDATE foundry_automation.run_controls SET mode='cancelled',revision=revision+1 WHERE run_id=${claim.run.id}`;
        yield* sql`UPDATE foundry_automation.dispatch_runs SET state='failed',reason='cancelled' WHERE run_id=${claim.run.id}`;
        yield* sql`UPDATE foundry_automation.dispatch_workers SET run_id=NULL,claim_owner=NULL,lease_until='-infinity' WHERE worker_id=${claim.workerId}`;
        return true;
      }),
    );
  }, Effect.mapError(operationError));
  const startManual = Effect.fn("DispatchStore.startManual")(function* (
    input: typeof StartAutomationRun.Type,
    workerId: string,
    binding: unknown,
    identity: unknown,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const previousRun = yield* sql`SELECT id FROM foundry_automation.runs WHERE id=${input.id}`;
        yield* workflows.start(input);
        const existing = yield* sql<{
          same: boolean;
        }>`SELECT identity->>'instanceId'=${sql.json(identity)}::jsonb->>'instanceId' AND identity->>'operatorId'=${sql.json(identity)}::jsonb->>'operatorId' AS same FROM foundry_automation.manual_admissions WHERE run_id=${input.id}`;
        if (existing.length) {
          if (!existing[0]?.same) return yield* new DispatchError({ reason: "conflict" });
          const sameBinding = yield* sql<{
            same: boolean;
          }>`SELECT (binding-'identity')=(${sql.json(binding)}::jsonb-'identity') AS same FROM foundry_automation.dispatch_runs WHERE run_id=${input.id}`;
          if (!sameBinding[0]?.same) return yield* new DispatchError({ reason: "conflict" });
          return yield* read(input.factoryId, input.id);
        }
        if (previousRun.length) return yield* new DispatchError({ reason: "conflict" });
        const activeDefinition =
          yield* sql`SELECT h.version_id FROM foundry_automation.definition_heads h JOIN foundry_automation.definition_versions d ON d.id=h.version_id AND d.factory_id=h.factory_id WHERE h.factory_id=${input.factoryId} AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.workflow_versions) version WHERE version->>'versionId'=${input.workflowVersionId}) FOR SHARE OF h`;
        if (!activeDefinition.length) return yield* new DispatchError({ reason: "conflict" });
        yield* admission(input.id, input.commandId, identity);
        return yield* enroll({ factoryId: input.factoryId, runId: input.id, workerId, binding });
      }),
    );
  }, Effect.mapError(operationError));
  const startTriggered = Effect.fn("DispatchStore.startTriggered")(function* (
    input: typeof StartAutomationRun.Type,
    workerId: string,
    binding: unknown,
    trigger: { eventId: string; bindingId: string; generation: number; identity: unknown },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const eligible =
          yield* sql`SELECT b.id FROM foundry_automation.trigger_bindings b JOIN foundry_automation.unattended_grants g ON g.binding_id=b.id AND g.generation=b.generation AND g.enabled JOIN foundry_automation.trigger_events e ON e.binding_id=b.id AND e.generation=b.generation JOIN foundry_automation.definition_versions d ON d.id=b.definition_version_id AND d.factory_id=b.factory_id WHERE b.id=${trigger.bindingId} AND b.generation=${trigger.generation} AND e.id=${trigger.eventId} AND e.state IN ('accepted','blocked') AND b.state='active' AND b.factory_id=${input.factoryId} AND b.workflow_version_id=${input.workflowVersionId} AND g.identity=${sql.json(trigger.identity)}::jsonb AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.workflow_versions) v WHERE v->>'versionId'=${input.workflowVersionId}) FOR UPDATE OF b,e`;
        if (!eligible.length) return yield* new DispatchError({ reason: "conflict" });
        yield* workflows.start(input);
        yield* sql`INSERT INTO foundry_automation.trigger_admissions(run_id,event_id,binding_id,generation,identity) VALUES(${input.id},${trigger.eventId},${trigger.bindingId},${trigger.generation},${sql.json(trigger.identity)}) ON CONFLICT DO NOTHING`;
        const saved = yield* enroll({
          factoryId: input.factoryId,
          runId: input.id,
          workerId,
          binding,
        });
        yield* sql`UPDATE foundry_automation.trigger_events SET state='admitted',reason=NULL,run_id=${input.id} WHERE id=${trigger.eventId}`;
        return saved;
      }),
    );
  }, Effect.mapError(operationError));
  return DispatchStore.of({
    startTriggered,
    completePublish,
    archiveCursor,
    projectQuestions,
    answers,
    answerDelivered,
    startManual,
    enroll,
    read,
    claimNext,
    prepare,
    record,
    wait,
    release,
    permitted,
    admission,
    canLaunch,
    beginDelivery,
    approved,
    completeApproval,
    confirmCancel,
  });
});
export const layer = Layer.effect(DispatchStore, make);
