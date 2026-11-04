// @effect-diagnostics-next-line nodeBuiltinImport:off -- Required artifact bytes are verified incrementally without retaining whole blobs.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  FoundryWorkerExecution,
  FoundryWorkerLaunchInput,
  FoundryWorkerLaunchReceipt,
  type FoundryArchiveEvent,
  FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as DispatchStore from "./DispatchStore.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import * as Artifacts from "../foundry/Artifacts.ts";
import { decideStep } from "./stepDecision.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
export const DispatchBinding = Schema.Struct({
  identity: WorkerTransport.WorkerIdentity,
  projectId: ProjectId,
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  checks: Schema.Array(Schema.Struct({ id: Text, prompt: Text, command: Text, cwd: Text })).check(
    Schema.isMaxLength(100),
    Schema.makeFilter((checks) => new Set(checks.map((check) => check.id)).size === checks.length),
  ),
  requiredArtifacts: Schema.Array(
    Schema.Struct({ stepId: Text, names: Schema.Array(Text).check(Schema.isMaxLength(100)) }),
  ).check(
    Schema.isMaxLength(100),
    Schema.makeFilter(
      (requirements) =>
        new Set(requirements.map((entry) => entry.stepId)).size === requirements.length &&
        requirements.every((entry) => new Set(entry.names).size === entry.names.length),
    ),
  ),
});
export const EnrollDispatch = Schema.Struct({
  factoryId: Text,
  runId: Text,
  projectId: DispatchBinding.fields.projectId,
  model: DispatchBinding.fields.model,
  checks: DispatchBinding.fields.checks,
  requiredArtifacts: DispatchBinding.fields.requiredArtifacts,
});
export class SchedulerConfig extends Context.Service<
  SchedulerConfig,
  {
    readonly deviceId: WorkerTransport.WorkerIdentity["deviceId"];
    readonly environmentId: WorkerTransport.WorkerIdentity["environmentId"];
    readonly allowedRunIds: ReadonlyArray<string>;
  }
>()("t3/automation/Scheduler/SchedulerConfig") {}

export class SchedulerError extends Schema.TaggedError<SchedulerError>()("SchedulerError", {
  reason: Schema.Literals(["invalid_binding", "not_allowed", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Automation scheduler failed (${this.reason}).`;
  }
}
const failure = (cause: unknown) => new SchedulerError({ reason: "unavailable", cause });
const Receipt = Schema.Struct({
  receipt: FoundryWorkerLaunchReceipt,
  generation: Schema.Int,
  runId: FoundryWorkerExecution.fields.run.fields.id,
});
const Result = Schema.Struct({
  execution: FoundryWorkerExecution,
  artifacts: Schema.Array(FoundryArtifactManifest),
});

const decodeBytes = Schema.decodeEffect(Schema.Uint8ArrayFromBase64);
const decodeEnroll = Schema.decodeEffect(EnrollDispatch, { onExcessProperty: "error" });
const decodeBinding = Schema.decodeUnknownEffect(DispatchBinding);
const decodeResult = Schema.decodeUnknownEffect(Result);
const decodeLaunch = Schema.decodeUnknownEffect(FoundryWorkerLaunchInput);
const decodeReceipt = Schema.decodeUnknownEffect(Receipt);
const encodeCommandKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Int])),
);

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly enroll: (
      request: HttpServerRequest.HttpServerRequest,
      input: typeof EnrollDispatch.Type,
    ) => Effect.Effect<DispatchStore.DispatchRun, SchedulerError>;
    readonly read: (
      request: HttpServerRequest.HttpServerRequest,
      factoryId: string,
      runId: string,
    ) => Effect.Effect<DispatchStore.DispatchRun, SchedulerError>;
    readonly tick: Effect.Effect<boolean, SchedulerError>;
  }
>()("t3/automation/Scheduler") {}

const make = Effect.gen(function* () {
  const store = yield* DispatchStore.DispatchStore;
  const worker = yield* WorkerTransport.WorkerTransport;
  const archive = yield* ThreadArchive.ThreadArchive;
  const artifacts = yield* Artifacts.Artifacts;
  const config = yield* SchedulerConfig;
  const crypto = yield* Crypto.Crypto;
  const owner = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const workerId = config.deviceId;
  const permitted = (runId: string) => config.allowedRunIds.includes(runId);
  const verifyArtifact = Effect.fn("Scheduler.verifyArtifact")(function* (
    identity: WorkerTransport.WorkerIdentity,
    item: FoundryArtifactManifest,
  ) {
    const stored = yield* artifacts.status(identity, item.reference);
    if (
      stored.state !== "published" ||
      stored.sha256 !== item.sha256 ||
      stored.sizeBytes !== item.sizeBytes
    )
      return false;
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
        return false;
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < item.sizeBytes);
    return offset === item.sizeBytes && hash.digest("hex") === item.sha256;
  });
  const enroll = Effect.fn("Scheduler.enroll")(function* (
    request: HttpServerRequest.HttpServerRequest,
    raw: typeof EnrollDispatch.Type,
  ) {
    const input = yield* decodeEnroll(raw);
    if (!permitted(input.runId)) return yield* new SchedulerError({ reason: "not_allowed" });
    const identity = yield* worker.authorize(request, config);
    return yield* store.enroll({
      factoryId: input.factoryId,
      runId: input.runId,
      workerId,
      binding: {
        identity,
        projectId: input.projectId,
        model: input.model,
        checks: input.checks,
        requiredArtifacts: input.requiredArtifacts,
      },
    });
  }, Effect.mapError(failure));
  const read = Effect.fn("Scheduler.read")(function* (
    request: HttpServerRequest.HttpServerRequest,
    factoryId: string,
    runId: string,
  ) {
    if (!permitted(runId)) return yield* new SchedulerError({ reason: "not_allowed" });
    const identity = yield* worker.identityForRead(request);
    const saved = yield* store.read(factoryId, runId);
    const binding = yield* decodeBinding(saved.binding);
    if (
      identity.instanceId !== binding.identity.instanceId ||
      identity.operatorId !== binding.identity.operatorId
    )
      return yield* new SchedulerError({ reason: "not_allowed" });
    return saved;
  }, Effect.mapError(failure));
  const perform = Effect.fn("Scheduler.perform")(function* (claim: DispatchStore.DispatchClaim) {
    if (!permitted(claim.run.id)) {
      yield* store.wait(claim, "run_not_enabled");
      return;
    }
    const binding = yield* decodeBinding(claim.binding);
    if (
      binding.requiredArtifacts.some(
        (entry) => !claim.workflow.steps.some((step) => step.id === entry.stepId),
      )
    ) {
      yield* store.wait(claim, "invalid_artifact_requirement");
      return;
    }
    if (
      binding.identity.deviceId !== config.deviceId ||
      binding.identity.environmentId !== config.environmentId
    )
      return yield* new SchedulerError({ reason: "invalid_binding" });
    const ordinal = claim.attempts.findIndex((attempt) => attempt.state !== "succeeded");
    const index = ordinal < 0 ? claim.attempts.length : ordinal;
    const step = claim.workflow.steps[index];
    if (!step) return;
    if (step.kind === "approval" || step.kind === "publish") {
      yield* store.wait(claim, `${step.kind}_required`);
      return;
    }
    const check =
      step.kind === "test" ? binding.checks.find((entry) => entry.id === step.checkId) : undefined;
    if (step.kind === "test" && !check) {
      yield* store.wait(claim, "check_not_configured");
      return;
    }
    let attempt = claim.attempts[index];
    if (!attempt) {
      const digest = Hex.encode(
        yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(yield* encodeCommandKey([claim.run.id, index])),
        ),
      );
      const commandId = CommandId.make(`automation:${digest}`);
      const previous = claim.attempts[index - 1];
      const previousResult = previous ? yield* decodeResult(previous.result) : null;
      if (previousResult) {
        for (const item of previousResult.artifacts) {
          if (!(yield* verifyArtifact(binding.identity, item))) {
            yield* store.wait(claim, "handoff_artifact_pending");
            return;
          }
        }
      }
      const previousExecution = previousResult?.execution.lifecycle
        ? {
            commandId: previousResult.execution.receipt.commandId,
            generation: previousResult.execution.lifecycle.generation,
          }
        : undefined;
      if (previous && !previousExecution) {
        yield* store.wait(claim, "handoff_pending");
        return;
      }
      const request: FoundryWorkerLaunchInput = {
        commandId,
        projectId: binding.projectId,
        model: binding.model,
        title: `Automation ${step.id}`.slice(0, 200),
        prompt: step.kind === "agent" ? step.prompt : check!.prompt,
        workspaceMode: "checkout",
        ...(previousExecution ? { previousExecution } : {}),
        ...(previousResult?.artifacts.length ? { inputArtifacts: previousResult.artifacts } : {}),
      };
      attempt = yield* store.prepare(claim, { ordinal: index, commandId, request });
    }
    const request = yield* decodeLaunch(attempt.request);
    const expected = attempt.receipt === null ? null : yield* decodeReceipt(attempt.receipt);
    let execution = yield* worker.read(binding.identity, { commandId: request.commandId });
    if (!execution) {
      if (expected) {
        yield* store.wait(claim, "accepted_attempt_missing");
        return;
      }
      const status = yield* worker.status(binding.identity);
      if (!status.providerReady || status.capacityAvailable !== true) {
        yield* store.wait(claim, "worker_not_ready");
        return;
      }
      yield* worker.launch(binding.identity, request);
      execution = yield* worker.read(binding.identity, { commandId: request.commandId });
      if (!execution) {
        yield* store.wait(claim, "dispatch_uncertain");
        return;
      }
    }
    const lifecycle = execution.lifecycle;
    if (
      !lifecycle ||
      execution.receipt.commandId !== request.commandId ||
      (expected &&
        (expected.generation !== lifecycle.generation ||
          expected.runId !== execution.run.id ||
          expected.receipt.threadId !== execution.receipt.threadId ||
          expected.receipt.sequence !== execution.receipt.sequence))
    ) {
      yield* store.wait(claim, "execution_binding_mismatch");
      return;
    }
    const receipt = {
      receipt: execution.receipt,
      generation: lifecycle.generation,
      runId: execution.run.id,
    };
    if (!expected)
      yield* store.record(claim, {
        commandId: attempt.commandId,
        state: "running",
        reason: "worker_result_pending",
        receipt,
        result: null,
      });
    if (!lifecycle.manifest && ["active", "finalizing"].includes(lifecycle.state))
      yield* worker
        .renew(binding.identity, { commandId: request.commandId, generation: lifecycle.generation })
        .pipe(Effect.ignore);
    const final = lifecycle.manifest?.archive;
    if (
      final &&
      (final.instanceId !== binding.identity.instanceId ||
        final.deviceId !== binding.identity.deviceId ||
        final.deviceGeneration !== binding.identity.deviceGeneration ||
        final.owner.environmentId !== binding.identity.environmentId ||
        final.owner.threadId !== execution.receipt.threadId)
    ) {
      yield* store.wait(claim, "archive_binding_mismatch");
      return;
    }
    const events: FoundryArchiveEvent[] = [];
    const confirmedArtifacts: FoundryArtifactManifest[] = [];
    let status = null;
    let artifactsReady = false;
    if (final) {
      status = yield* archive.cursor(binding.identity, final.owner);
      let after = 0;
      while (after < final.cursor) {
        if (events.length >= 10_000) {
          yield* store.wait(claim, "archive_result_limit");
          return;
        }
        const page = yield* archive.read(binding.identity, {
          owner: final.owner,
          after,
          limit: 50,
        });
        if (!page.events.length) break;
        events.push(...page.events);
        const next = page.events.at(-1)!.sequence;
        if (next <= after) break;
        after = next;
      }
      const names =
        binding.requiredArtifacts.find((entry) => entry.stepId === step.id)?.names ?? [];
      const referencedArtifacts = new Set(
        events.flatMap((entry) =>
          entry.sequence <= final.cursor &&
          entry.event.type === "message.updated" &&
          entry.event.payload.runId === execution.run.id
            ? entry.event.payload.attachments.flatMap((attachment) =>
                attachment.foundryArtifact ? [attachment.foundryArtifact.reference.artifactId] : [],
              )
            : [],
        ),
      );
      let before: string | undefined;
      do {
        const page = yield* artifacts.list(binding.identity, {
          owner: final.owner,
          ...(before ? { before } : {}),
        });
        confirmedArtifacts.push(
          ...page.items.filter(
            (item) =>
              names.includes(item.name) && referencedArtifacts.has(item.reference.artifactId),
          ),
        );
        before = page.nextCursor ?? undefined;
      } while (before);
      artifactsReady = names.every(
        (name) => confirmedArtifacts.filter((item) => item.name === name).length === 1,
      );
      for (const item of confirmedArtifacts) {
        if (!(yield* verifyArtifact(binding.identity, item))) artifactsReady = false;
      }
    }
    const decision = decideStep({
      execution,
      archive: status,
      events,
      artifactsReady,
      ...(check ? { command: check.command, cwd: check.cwd } : {}),
    });
    yield* store.record(claim, {
      commandId: attempt.commandId,
      ...decision,
      receipt,
      result:
        decision.state === "succeeded" || decision.state === "failed"
          ? { execution, artifacts: confirmedArtifacts }
          : null,
    });
  });
  const tick = Effect.gen(function* () {
    const claim = yield* store.claimNext({ workerId, owner, leaseMillis: 60_000 });
    if (!claim) return false;
    yield* perform(claim).pipe(
      Effect.catch((error) =>
        store
          .wait(
            claim,
            error._tag === "WorkerTransportError"
              ? (error.workerCode ?? error.reason)
              : "reconciliation_pending",
          )
          .pipe(Effect.asVoid),
      ),
      Effect.ensuring(store.release(claim).pipe(Effect.ignore)),
    );
    return true;
  }).pipe(Effect.mapError(failure));
  return Scheduler.of({ enroll, read, tick });
});
export const layer = Layer.effect(Scheduler, make);
