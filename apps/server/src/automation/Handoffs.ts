// @effect-diagnostics nodeBuiltinImport:off -- Central confirmation hashes bounded artifact chunks without retaining the bundle.
import * as NodeCrypto from "node:crypto";
import {
  AutomationApplicationError,
  AutomationHandoff,
  AutomationHandoffCommand,
  AutomationHandoffQuery,
  CommandId,
  ProjectId,
  FoundryWorkerExecution,
  FoundryWorkerHandoffOpen,
  FoundryWorkerHandoffResult,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as Workflows from "./Workflows.ts";
import { DispatchBinding, SchedulerConfig } from "./Scheduler.ts";
import * as Artifacts from "../foundry/Artifacts.ts";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";

const decodeBinding = Schema.decodeUnknownEffect(DispatchBinding);
const isCancelledBeforeStart = Schema.is(
  Schema.Struct({ cancelledBeforeStart: Schema.Literal(true) }),
);
const decodeAssignment = Schema.decodeUnknownEffect(
  Schema.Struct({ identity: WorkerTransport.WorkerIdentity, projectId: ProjectId }),
);
const decodeOpen = Schema.decodeUnknownEffect(FoundryWorkerHandoffOpen);
const decodeResult = Schema.decodeUnknownEffect(FoundryWorkerHandoffResult);
const decodeExecution = Schema.decodeUnknownEffect(
  Schema.Struct({ execution: FoundryWorkerExecution }),
);
const decodeCommand = Schema.decodeEffect(AutomationHandoffCommand, { onExcessProperty: "error" });
const decodeQuery = Schema.decodeEffect(AutomationHandoffQuery, { onExcessProperty: "error" });
const decodeBytes = Schema.decodeEffect(Schema.Uint8ArrayFromBase64);
const isNonWriterStep = Schema.is(
  Schema.Struct({ kind: Schema.Literals(["approval", "publish"]) }),
);
const isError = Schema.is(AutomationApplicationError);
const isWorkerError = Schema.is(WorkerTransport.WorkerTransportError);
const fail = (code: AutomationApplicationError["code"]) => new AutomationApplicationError({ code });
const failure = (cause: unknown) => {
  if (isError(cause)) return cause;
  if (isWorkerError(cause)) {
    if (cause.reason === "forbidden") return fail("forbidden");
    if (cause.workerCode === "handoff_changed") return fail("workspace_changed");
    if (
      cause.handoffCode === "writer_not_ended" ||
      cause.handoffCode === "checkpoint_pending" ||
      cause.handoffCode === "archive_missing" ||
      cause.handoffCode === "workspace_changed" ||
      cause.handoffCode === "conflict" ||
      cause.handoffCode === "not_found"
    )
      return fail(cause.handoffCode);
  }
  return fail("unavailable");
};
type Request = HttpServerRequest.HttpServerRequest;
export class Handoffs extends Context.Service<
  Handoffs,
  {
    readonly query: (
      request: Request,
      input: AutomationHandoffQuery,
    ) => Effect.Effect<ReadonlyArray<AutomationHandoff>, AutomationApplicationError>;
    readonly execute: (
      request: Request,
      input: AutomationHandoffCommand,
    ) => Effect.Effect<AutomationHandoff, AutomationApplicationError>;
  }
>()("t3/automation/Handoffs") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const store = yield* DispatchStore.DispatchStore;
  const workflows = yield* Workflows.Workflows;
  const worker = yield* WorkerTransport.WorkerTransport;
  const artifacts = yield* Artifacts.Artifacts;
  const archive = yield* ThreadArchive.ThreadArchive;
  const target = yield* SchedulerConfig;
  const crypto = yield* Crypto.Crypto;
  const columns = sql.literal(
    `id,factory_id AS "factoryId",work_item_id AS "workItemId",run_id AS "runId",source_command_id AS "sourceCommandId",environment_id AS "environmentId",generation,base_revision AS "baseRevision",state,mode,receipt,result,continuation_run_id AS "continuationRunId",COALESCE((SELECT jsonb_agg(c.payload ORDER BY c.id) FROM foundry_automation.handoff_commands c WHERE c.handoff_id=work_item_handoffs.id AND c.receipt IS NULL AND ((work_item_handoffs.state='opening' AND c.payload->>'op'='takeOver') OR (work_item_handoffs.state='returning' AND c.payload->>'expectedGeneration'=work_item_handoffs.generation::text AND c.payload->>'op' IN ('returnHandoff','reopenHandoff')))), '[]'::jsonb) AS "pendingCommands"`,
  );
  const read = Effect.fn("Handoffs.read")(function* (id: string) {
    const rows =
      yield* sql<AutomationHandoff>`SELECT ${columns} FROM foundry_automation.work_item_handoffs WHERE id=${id}`;
    if (!rows[0]) return yield* fail("not_found");
    return rows[0];
  });
  const lock = Effect.fn("Handoffs.lock")(function* (workItemId: string, runId: string) {
    yield* sql`SELECT worker_id FROM foundry_automation.dispatch_workers WHERE worker_id=${target.deviceId} FOR UPDATE`;
    yield* sql`SELECT f.id FROM foundry_automation.factories f JOIN foundry_automation.work_items w ON w.factory_id=f.id WHERE w.id=${workItemId} FOR UPDATE OF f`;
    yield* sql`SELECT run_id FROM foundry_automation.run_controls WHERE run_id=${runId} FOR UPDATE`;
  });
  const query = Effect.fn("Handoffs.query")(function* (
    request: Request,
    raw: AutomationHandoffQuery,
  ) {
    const input = yield* decodeQuery(raw);
    const identity = yield* worker.identityForRead(request);
    return input.op === "handoffs"
      ? yield* sql<AutomationHandoff>`SELECT ${columns} FROM foundry_automation.work_item_handoffs WHERE factory_id=${input.factoryId} AND work_item_id=${input.workItemId} AND instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} ORDER BY id DESC LIMIT 50`
      : yield* sql<AutomationHandoff>`SELECT ${columns} FROM foundry_automation.work_item_handoffs WHERE environment_id=${input.environmentId} AND receipt->>'threadId'=${input.threadId} AND instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} LIMIT 1`;
  }, Effect.mapError(failure));
  const confirmBundle = Effect.fn("Handoffs.confirmBundle")(function* (
    identity: WorkerTransport.WorkerIdentity,
    item: FoundryArtifactManifest,
  ) {
    if (
      item.reference.instanceId !== identity.instanceId ||
      item.reference.owner.environmentId !== identity.environmentId
    )
      return yield* fail("archive_missing");
    const saved = yield* artifacts.metadata(identity, item.reference);
    if (
      saved.sha256 !== item.sha256 ||
      saved.sizeBytes !== item.sizeBytes ||
      item.sizeBytes > 50 * 1024 * 1024
    )
      return yield* fail("archive_missing");
    const hash = NodeCrypto.createHash("sha256");
    let offset = 0;
    do {
      const chunk = yield* artifacts.read(identity, { reference: item.reference, offset });
      const bytes = yield* decodeBytes(chunk.data);
      if (
        chunk.offset !== offset ||
        chunk.total !== item.sizeBytes ||
        chunk.fileSha256 !== item.sha256 ||
        (bytes.length === 0 && offset < item.sizeBytes)
      )
        return yield* fail("archive_missing");
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < item.sizeBytes);
    if (offset !== item.sizeBytes || hash.digest("hex") !== item.sha256)
      return yield* fail("archive_missing");
  });
  const execute = Effect.fn("Handoffs.execute")(function* (
    request: Request,
    raw: AutomationHandoffCommand,
  ) {
    const input = yield* decodeCommand(raw);
    const principal = yield* worker.identityForWrite(request);
    const existing = input.op === "takeOver" ? null : yield* read(input.handoffId);
    if (existing && existing.factoryId !== input.factoryId) return yield* fail("not_found");
    const runId = input.op === "takeOver" ? input.runId : existing!.runId;
    const run = yield* store.read(input.factoryId, runId);
    const originalBinding = yield* decodeBinding(run.binding);
    const sourceCommandId =
      input.op === "takeOver" ? input.sourceCommandId : existing!.sourceCommandId;
    const assignedAttempt = run.attempts.find((attempt) => attempt.commandId === sourceCommandId);
    if (!assignedAttempt) return yield* fail("not_found");
    const assignment = assignedAttempt.workerBinding
      ? yield* decodeAssignment(assignedAttempt.workerBinding)
      : originalBinding;
    const binding = { ...originalBinding, ...assignment };
    if (
      principal.instanceId !== originalBinding.identity.instanceId ||
      principal.operatorId !== originalBinding.identity.operatorId ||
      binding.identity.instanceId !== originalBinding.identity.instanceId ||
      binding.identity.operatorId !== originalBinding.identity.operatorId ||
      (existing && existing.environmentId !== binding.identity.environmentId)
    )
      return yield* fail("forbidden");
    const sourceTarget = {
      deviceId: binding.identity.deviceId,
      environmentId: binding.identity.environmentId,
    };
    const identity = yield* worker.authorize(request, sourceTarget);
    if (
      identity.instanceId !== binding.identity.instanceId ||
      identity.operatorId !== binding.identity.operatorId ||
      identity.deviceId !== binding.identity.deviceId ||
      identity.environmentId !== binding.identity.environmentId ||
      identity.deviceGeneration !== binding.identity.deviceGeneration ||
      identity.accessGeneration !== binding.identity.accessGeneration ||
      identity.automationGeneration !== binding.identity.automationGeneration
    )
      return yield* fail("forbidden");
    const reauthorize = Effect.fn("Handoffs.reauthorize")(function* () {
      const fresh = yield* worker.authorize(request, sourceTarget);
      if (
        fresh.instanceId !== identity.instanceId ||
        fresh.operatorId !== identity.operatorId ||
        fresh.deviceId !== identity.deviceId ||
        fresh.environmentId !== identity.environmentId ||
        fresh.deviceGeneration !== identity.deviceGeneration ||
        fresh.accessGeneration !== identity.accessGeneration ||
        fresh.automationGeneration !== identity.automationGeneration
      )
        return yield* fail("forbidden");
    });
    const id = input.op === "takeOver" ? input.id : input.handoffId;
    const prepared = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(run.run.workItemId, runId);
        const previous = yield* sql<{
          same: boolean;
          receipt: AutomationHandoff | null;
        }>`SELECT payload=${sql.json(input)}::jsonb AS same,receipt FROM foundry_automation.handoff_commands WHERE id=${input.commandId}`;
        if (previous[0]) {
          if (!previous[0].same) return yield* fail("conflict");
          if (previous[0].receipt)
            return { done: previous[0].receipt, handoff: previous[0].receipt };
          const handoff = yield* read(id);
          if (input.op !== "takeOver" && handoff.generation !== input.expectedGeneration)
            return yield* fail("conflict");
          if (input.op === "returnHandoff" && handoff.state !== "returning")
            return yield* fail("conflict");
          return { done: null, handoff };
        }
        if (input.op === "takeOver") {
          const current = yield* store.read(input.factoryId, runId);
          if (current.revision !== input.expectedRevision) return yield* fail("conflict");
          if (
            current.mode !== "paused" &&
            current.mode !== "cancelled" &&
            current.state !== "failed" &&
            current.state !== "succeeded"
          )
            return yield* fail("writer_not_ended");
          const held =
            yield* sql`SELECT h.id FROM foundry_automation.work_item_handoffs h JOIN foundry_automation.dispatch_runs d ON d.run_id=h.run_id WHERE h.run_id=${runId} OR (h.environment_id=${identity.environmentId} AND h.state<>'returned')`;
          if (held.length) return yield* fail("conflict");
          const other =
            yield* sql`SELECT r.id FROM foundry_automation.runs r JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id JOIN foundry_automation.run_controls c ON c.run_id=r.id WHERE r.work_item_id=${run.run.workItemId} AND r.id<>${runId} AND d.state IN ('running','waiting') AND c.mode<>'cancelled'`;
          if (other.length) return yield* fail("writer_not_ended");
          const deliveries = yield* sql<{
            state: string;
            result: unknown;
            request: unknown;
          }>`SELECT o.state,a.result,a.request FROM foundry_automation.step_attempts a JOIN foundry_automation.dispatch_outbox o ON o.command_id=a.command_id JOIN foundry_automation.dispatch_runs d ON d.run_id=a.run_id WHERE a.run_id=${runId} OR COALESCE(a.worker_id,d.worker_id)=${identity.deviceId}`;
          if (
            deliveries.some(
              (attempt) =>
                attempt.state !== "pending" &&
                !(attempt.state === "confirmed" && isNonWriterStep(attempt.request)) &&
                !DispatchStore.writerEnded(attempt.result) &&
                !isCancelledBeforeStart(attempt.result),
            )
          )
            return yield* fail("writer_not_ended");
          const source = current.attempts.find(
            (attempt) => attempt.commandId === input.sourceCommandId,
          );
          if (!source || !DispatchStore.writerEnded(source.result))
            return yield* fail("writer_not_ended");
          const { execution } = yield* decodeExecution(source.result);
          const manifest = execution.lifecycle?.manifest;
          if (
            !manifest?.checkpointRef ||
            !manifest.checkpointId ||
            execution.run.checkpointId !== manifest.checkpointId ||
            manifest.runId !== execution.run.id ||
            manifest.generation !== execution.lifecycle?.generation
          )
            return yield* fail("checkpoint_pending");
          const evidence = manifest.publishEvidence;
          if (input.mode === "archive" && !evidence) return yield* fail("archive_missing");
          const [workItem] = yield* sql<{
            title: string;
          }>`SELECT title FROM foundry_automation.work_items WHERE factory_id=${input.factoryId} AND id=${run.run.workItemId}`;
          if (!workItem) return yield* fail("not_found");
          const open = yield* decodeOpen({
            commandId: CommandId.make(`handoff:open:${input.id}`),
            handoffId: input.id,
            factoryId: input.factoryId,
            workItemId: run.run.workItemId,
            runId,
            source: { commandId: execution.receipt.commandId, generation: manifest.generation },
            projectId: binding.projectId,
            mode: input.mode,
            title: workItem.title.slice(0, 200),
            ...(input.mode === "archive" && evidence
              ? {
                  archive: {
                    bundle: evidence.bundle,
                    commitSha: evidence.commitSha,
                    treeSha: evidence.treeSha,
                    sourceThreadId: execution.receipt.threadId,
                  },
                }
              : {}),
          });
          yield* sql`INSERT INTO foundry_automation.work_item_handoffs(id,factory_id,work_item_id,run_id,source_command_id,instance_id,operator_id,environment_id,generation,base_revision,state,mode,open_request) VALUES(${id},${input.factoryId},${run.run.workItemId},${runId},${input.sourceCommandId},${identity.instanceId},${identity.operatorId},${identity.environmentId},0,${run.run.revision},'opening',${input.mode},${sql.json(open)})`;
          yield* sql`UPDATE foundry_automation.run_controls SET mode='paused',revision=revision+1,result_revision=result_revision+1 WHERE run_id=${runId}`;
          yield* sql`UPDATE foundry_automation.dispatch_workers SET run_id=NULL,claim_owner=NULL,claim_generation=claim_generation+1,lease_until='-infinity' WHERE worker_id=${target.deviceId} AND run_id=${runId}`;
        } else {
          const handoff = yield* read(id);
          if (
            handoff.generation !== input.expectedGeneration ||
            (input.op === "returnHandoff"
              ? handoff.state !== "open"
              : handoff.state !== "returning")
          )
            return yield* fail("conflict");
          if (input.op === "reopenHandoff") {
            const unresolved =
              yield* sql`SELECT id FROM foundry_automation.handoff_commands WHERE handoff_id=${id} AND receipt IS NULL AND payload->>'op'='reopenHandoff' AND payload->>'expectedGeneration'=${String(input.expectedGeneration)}`;
            if (unresolved.length) return yield* fail("conflict");
          }
          if (input.op === "returnHandoff") {
            if (handoff.receipt?.baseCommit !== input.expectedBaseCommit)
              return yield* fail("conflict");
            yield* sql`UPDATE foundry_automation.work_item_handoffs SET state='returning' WHERE id=${id}`;
          }
        }
        yield* sql`INSERT INTO foundry_automation.handoff_commands(id,payload,handoff_id) VALUES(${input.commandId},${sql.json(input)},${id})`;
        return { done: null, handoff: yield* read(id) };
      }),
    );
    if (prepared.done) return prepared.done;
    const hash = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(input.commandId)),
    );
    if (input.op === "takeOver") {
      const rows = yield* sql<{
        open: unknown;
      }>`SELECT open_request AS open FROM foundry_automation.work_item_handoffs WHERE id=${id}`;
      const open = yield* decodeOpen(rows[0]!.open);
      if (open.archive) yield* confirmBundle(identity, open.archive.bundle);
      const receipt = yield* worker.handoffOpen(identity, open);
      if (receipt.handoffId !== id || receipt.mode !== open.mode) return yield* fail("conflict");
      yield* reauthorize();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(run.run.workItemId, runId);
          const saved = yield* read(id);
          if (saved.state !== "opening" && saved.state !== "open") return yield* fail("conflict");
          yield* sql`UPDATE foundry_automation.work_item_handoffs SET receipt=${sql.json(receipt)},state='open' WHERE id=${id}`;
          const final = yield* read(id);
          yield* sql`UPDATE foundry_automation.handoff_commands SET receipt=${sql.json(final)} WHERE id=${input.commandId}`;
          return final;
        }),
      );
    }
    if (input.op === "reopenHandoff") {
      yield* worker.handoffReopen(identity, {
        commandId: CommandId.make(`handoff:reopen:${hash}`),
        handoffId: id,
      });
      yield* reauthorize();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(run.run.workItemId, runId);
          const saved = yield* read(id);
          if (saved.state !== "returning" || saved.generation !== input.expectedGeneration)
            return yield* fail("conflict");
          yield* sql`UPDATE foundry_automation.work_item_handoffs SET state='open',generation=generation+1 WHERE id=${id}`;
          const final = yield* read(id);
          yield* sql`UPDATE foundry_automation.handoff_commands SET receipt=${sql.json(final)} WHERE id=${input.commandId}`;
          return final;
        }),
      );
    }
    const result = yield* decodeResult(
      yield* worker.handoffFinish(identity, {
        commandId: CommandId.make(`handoff:return:${hash}`),
        handoffId: id,
        expectedBaseCommit: input.expectedBaseCommit,
        tests: input.tests,
        openPoints: input.openPoints,
      }),
    );
    if (
      result.receipt.handoffId !== id ||
      result.receipt.threadId !== prepared.handoff.receipt?.threadId ||
      result.receipt.baseCommit !== input.expectedBaseCommit ||
      result.tests !== input.tests ||
      result.openPoints !== input.openPoints ||
      result.bundle.reference.owner.threadId !== result.receipt.threadId ||
      result.archive.instanceId !== identity.instanceId ||
      result.archive.deviceId !== identity.deviceId ||
      result.archive.deviceGeneration !== identity.deviceGeneration ||
      result.archive.owner.environmentId !== identity.environmentId ||
      result.archive.owner.threadId !== result.receipt.threadId
    )
      return yield* fail("conflict");
    yield* confirmBundle(identity, result.bundle);
    const cursor = yield* archive.cursor(
      { instanceId: identity.instanceId, operatorId: identity.operatorId },
      result.archive.owner,
    );
    if (
      !cursor.complete ||
      !cursor.sourceComplete ||
      cursor.missingArtifacts.length ||
      cursor.missingAttachmentCount ||
      cursor.confirmedCursor < result.archive.cursor ||
      cursor.confirmedSourceSequence < result.archive.sourceSequence
    )
      return yield* fail("archive_missing");
    yield* reauthorize();
    const continuationRunId = `handoff:run:${hash}`;
    const coordinatorIdentity =
      run.workflow.execution || run.workflow.v4
        ? yield* worker.authorize(request, target)
        : identity;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(run.run.workItemId, runId);
        const saved = yield* read(id);
        const previous = yield* sql<{
          receipt: AutomationHandoff | null;
        }>`SELECT receipt FROM foundry_automation.handoff_commands WHERE id=${input.commandId}`;
        if (previous[0]?.receipt) return previous[0].receipt;
        if (saved.state !== "returning" || saved.generation !== input.expectedGeneration)
          return yield* fail("conflict");
        yield* sql`UPDATE foundry_automation.work_item_handoffs SET state='returned',generation=generation+1,result=${sql.json(result)} WHERE id=${id}`;
        yield* workflows.start({
          commandId: `handoff:continue:${hash}`,
          id: continuationRunId,
          factoryId: input.factoryId,
          workItemId: run.run.workItemId,
          workflowVersionId: run.run.workflowVersionId,
          revision: result.commitSha,
          ...(run.run.inputs ? { inputs: run.run.inputs } : {}),
        });
        yield* store.admission(continuationRunId, `handoff:continue:${hash}`, identity);
        yield* store.enroll({
          factoryId: input.factoryId,
          runId: continuationRunId,
          workerId: target.deviceId,
          binding: {
            ...originalBinding,
            identity: coordinatorIdentity,
            projectId: result.receipt.projectId,
            ...(run.workflow.execution || run.workflow.v4
              ? { workers: [{ identity, projectId: result.receipt.projectId }] }
              : { previousHandoff: { handoffId: id, commitSha: result.commitSha } }),
          },
        });
        yield* sql`UPDATE foundry_automation.run_controls SET mode='paused' WHERE run_id=${continuationRunId}`;
        yield* sql`UPDATE foundry_automation.run_controls SET revision=revision+1,result_revision=result_revision+1 WHERE run_id=${runId}`;
        yield* sql`UPDATE foundry_automation.work_item_handoffs SET continuation_run_id=${continuationRunId} WHERE id=${id}`;
        const final = yield* read(id);
        yield* sql`UPDATE foundry_automation.handoff_commands SET receipt=${sql.json(final)} WHERE id=${input.commandId}`;
        return final;
      }),
    );
  }, Effect.mapError(failure));
  return Handoffs.of({ query, execute });
});
export const layer = Layer.effect(Handoffs, make);
