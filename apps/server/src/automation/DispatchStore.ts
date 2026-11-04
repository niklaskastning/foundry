import { type AutomationRun, type AutomationWorkflowVersion } from "@t3tools/contracts";
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
export type DispatchState = "running" | "waiting" | "failed" | "succeeded";
export interface DispatchAttempt {
  readonly commandId: string;
  readonly ordinal: number;
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
}
export interface DispatchClaim extends DispatchRun {
  readonly owner: string;
  readonly generation: number;
}
export class DispatchStore extends Context.Service<
  DispatchStore,
  {
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
    readonly release: (claim: DispatchClaim) => Effect.Effect<void, DispatchError>;
  }
>()("t3/automation/DispatchStore") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const workflows = yield* Workflows.Workflows;
  const factories = yield* Factories.Factories;
  const attempts = Effect.fn("DispatchStore.attempts")(function* (runId: string) {
    return yield* sql<DispatchAttempt>`SELECT command_id AS "commandId",ordinal,request,state,reason,receipt,result FROM foundry_automation.step_attempts WHERE run_id=${runId} ORDER BY ordinal`;
  });
  const read = Effect.fn("DispatchStore.read")(function* (factoryId: string, runId: string) {
    const run = yield* workflows.readRun(factoryId, runId);
    const rows = yield* sql<{
      workerId: string;
      binding: unknown;
      state: DispatchState;
      reason: string | null;
    }>`SELECT worker_id AS "workerId",binding,state,reason FROM foundry_automation.dispatch_runs WHERE run_id=${runId}`;
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
        let runId = slots[0].runId;
        if (!runId) {
          const queued = yield* sql<{
            runId: string;
          }>`SELECT run_id AS "runId" FROM foundry_automation.dispatch_runs WHERE worker_id=${input.workerId} AND state IN ('running','waiting') ORDER BY enrolled_at,run_id LIMIT 1`;
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
        const existing = yield* attempts(claim.run.id);
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
          run.state === "failed" ||
          run.state === "succeeded" ||
          input.ordinal !== existing.length ||
          !run.workflow.steps[input.ordinal] ||
          existing.some((a) => a.state !== "succeeded")
        )
          return yield* new DispatchError({ reason: "invalid_step" });
        yield* sql`INSERT INTO foundry_automation.step_attempts(command_id,run_id,ordinal,request) VALUES(${input.commandId},${claim.run.id},${input.ordinal},${sql.json(input.request)})`;
        yield* sql`INSERT INTO foundry_automation.dispatch_outbox(command_id) VALUES(${input.commandId})`;
        yield* sql`UPDATE foundry_automation.dispatch_runs SET state='running',reason=NULL WHERE run_id=${claim.run.id}`;
        return (yield* attempts(claim.run.id))[input.ordinal]!;
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
        >`SELECT command_id AS "commandId",ordinal,request,state,reason,receipt,result, (receipt IS NULL OR ${sql.json(input.receipt)}::jsonb='null'::jsonb OR receipt=${sql.json(input.receipt)}::jsonb) AS "receiptMatches", (result=${sql.json(input.result)}::jsonb OR (result IS NULL AND ${sql.json(input.result)}::jsonb='null'::jsonb)) AS "resultMatches" FROM foundry_automation.step_attempts WHERE command_id=${input.commandId} AND run_id=${claim.run.id}`;
        const old = rows[0];
        if (!old) return yield* new DispatchError({ reason: "not_found" });
        if (!old.receiptMatches) return yield* new DispatchError({ reason: "conflict" });
        if (old.state === "succeeded" || old.state === "failed") {
          if (old.state !== input.state || old.reason !== input.reason || !old.resultMatches)
            return yield* new DispatchError({ reason: "conflict" });
          return true;
        }
        yield* sql`UPDATE foundry_automation.step_attempts SET state=${input.state},reason=${input.reason},receipt=COALESCE(receipt,NULLIF(${sql.json(input.receipt)}::jsonb,'null'::jsonb)),result=NULLIF(${sql.json(input.result)}::jsonb,'null'::jsonb) WHERE command_id=${input.commandId}`;
        yield* sql`UPDATE foundry_automation.dispatch_outbox SET state=CASE WHEN ${input.state} IN ('succeeded','failed') THEN 'confirmed' WHEN ${input.receipt !== null || old.receipt !== null} THEN 'delivered' ELSE state END WHERE command_id=${input.commandId}`;
        const workflow = yield* workflows.readVersion(
          claim.run.factoryId,
          claim.run.workflowVersionId,
        );
        const state: DispatchState =
          input.state === "failed"
            ? "failed"
            : input.state === "succeeded" && old.ordinal === workflow.steps.length - 1
              ? "succeeded"
              : input.state === "waiting" || input.state === "finalizing"
                ? "waiting"
                : "running";
        yield* sql`UPDATE foundry_automation.dispatch_runs SET state=${state},reason=${input.reason} WHERE run_id=${claim.run.id}`;
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
  return DispatchStore.of({ enroll, read, claimNext, prepare, record, wait, release });
});
export const layer = Layer.effect(DispatchStore, make);
