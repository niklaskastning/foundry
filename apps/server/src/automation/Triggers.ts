import {
  AutomationTriggerBinding,
  AutomationTriggerCommand,
  AutomationTriggerError,
  AutomationTriggerEvent,
  AutomationTriggerQuery,
  AutomationTriggerResult,
  type AutomationScheduleConfig,
  type EnvironmentId,
  type FoundryDeviceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as GatewayGrants from "../foundry/GatewayGrants.ts";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as Factories from "./Factories.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as Unattended from "./Unattended.ts";

export class TriggerConfig extends Context.Service<
  TriggerConfig,
  {
    readonly deviceId: FoundryDeviceId;
    readonly environmentId: EnvironmentId;
    readonly nextSchedule: (
      config: AutomationScheduleConfig,
      now: number,
    ) => Effect.Effect<number, AutomationTriggerError>;
  }
>()("t3/automation/Triggers/TriggerConfig") {}
export const PollCursor = Schema.Struct({
  since: Schema.Number,
  page: Schema.Int,
  windowEnd: Schema.Number,
});
export type PollCursor = typeof PollCursor.Type;
export interface PollBinding {
  readonly binding: AutomationTriggerBinding;
  readonly cursor: PollCursor;
  readonly failures: number;
}
export interface IncomingIssue {
  readonly id: string;
  readonly externalId: string;
  readonly revision: string;
  readonly title: string;
  readonly occurredAt: number;
  readonly payload: unknown;
}
type ScheduledBatch = {
  readonly bindingId: string;
  readonly generation: number;
  readonly expectedNextDueAt: number;
  readonly occurrences: ReadonlyArray<{ readonly id: string; readonly dueAt: number }>;
  readonly nextDueAt: number;
  readonly skipped: number;
};
export class Triggers extends Context.Service<
  Triggers,
  {
    readonly command: (
      request: HttpServerRequest.HttpServerRequest,
      input: AutomationTriggerCommand,
    ) => Effect.Effect<AutomationTriggerResult, AutomationTriggerError>;
    readonly query: (
      request: HttpServerRequest.HttpServerRequest,
      input: AutomationTriggerQuery,
    ) => Effect.Effect<AutomationTriggerResult, AutomationTriggerError>;
    readonly dueSchedules: (
      now: number,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<{
        id: string;
        generation: number;
        config: AutomationScheduleConfig;
        nextDueAt: number;
      }>,
      AutomationTriggerError
    >;
    readonly acceptScheduledBatch: (
      input: ScheduledBatch,
    ) => Effect.Effect<boolean, AutomationTriggerError>;
    readonly duePolls: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PollBinding>, AutomationTriggerError>;
    readonly acceptIssueBatch: (input: {
      bindingId: string;
      generation: number;
      expectedCursor: PollCursor;
      issues: ReadonlyArray<IncomingIssue>;
      nextCursor: PollCursor;
      complete: boolean;
    }) => Effect.Effect<boolean, AutomationTriggerError>;
    readonly pollFailed: (input: {
      bindingId: string;
      generation: number;
      expectedCursor: PollCursor;
      reason: string;
      retryAt: number;
    }) => Effect.Effect<void, AutomationTriggerError>;
    readonly admit: (eventId: string) => Effect.Effect<boolean, AutomationTriggerError>;
    readonly tick: Effect.Effect<number, AutomationTriggerError>;
  }
>()("t3/automation/Triggers") {}
const isTriggerError = Schema.is(AutomationTriggerError);
const failure = (cause: unknown) =>
  isTriggerError(cause) ? cause : new AutomationTriggerError({ code: "unavailable" });
const forbidden = () => new AutomationTriggerError({ code: "forbidden" });
const conflict = () => new AutomationTriggerError({ code: "conflict" });
const invalid = () => new AutomationTriggerError({ code: "invalid_input" });
const decodeBinding = Schema.decodeUnknownEffect(AutomationTriggerBinding);
const decodeResult = Schema.decodeUnknownEffect(AutomationTriggerResult);
const decodeEvent = Schema.decodeUnknownEffect(AutomationTriggerEvent);
const decodeCursor = Schema.decodeUnknownEffect(PollCursor);
const decodeCommand = Schema.decodeEffect(AutomationTriggerCommand, { onExcessProperty: "error" });
const decodeQuery = Schema.decodeEffect(AutomationTriggerQuery, { onExcessProperty: "error" });
const decodeIdentity = Schema.decodeUnknownEffect(GatewayGrants.UnattendedGatewayIdentity);
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
);
const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const gateway = yield* GatewayGrants.GatewayGrants;
  const worker = yield* WorkerTransport.WorkerTransport;
  const grants = yield* Unattended.Unattended;
  const store = yield* DispatchStore.DispatchStore;
  const factories = yield* Factories.Factories;
  const config = yield* TriggerConfig;
  const crypto = yield* Crypto.Crypto;
  const columns = sql`id,factory_id AS "factoryId",definition_version_id AS "definitionVersionId",workflow_version_id AS "workflowVersionId",repository,source,target,generation,state,activated_at::float8 AS "activatedAt",next_due_at::float8 AS "nextDueAt",next_poll_at::float8 AS "nextPollAt",reason,skipped_ranges AS "skippedRanges"`;
  const eventColumns = sql`id,binding_id AS "bindingId",generation,deduplication_key AS "deduplicationKey",source,external_id AS "externalId",revision,title,occurred_at::float8 AS "occurredAt",received_at::float8 AS "receivedAt",state,reason,run_id AS "runId"`;
  const hash = Effect.fn("Triggers.hash")((parts: ReadonlyArray<string | number>) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(encodeKey(parts)))
      .pipe(Effect.map(Hex.encode)),
  );
  const read = Effect.fn("Triggers.read")(function* (id: string) {
    const rows =
      yield* sql`SELECT ${columns},instance_id AS "instanceId",operator_id AS "operatorId",cursor,failures FROM foundry_automation.trigger_bindings WHERE id=${id}`;
    if (!rows[0]) return yield* new AutomationTriggerError({ code: "not_found" });
    return {
      binding: yield* decodeBinding(rows[0]),
      instanceId: String(rows[0].instanceId),
      operatorId: String(rows[0].operatorId),
      cursor: rows[0].cursor,
      failures: Number(rows[0].failures),
    };
  });
  const command = Effect.fn("Triggers.command")(function* (
    request: HttpServerRequest.HttpServerRequest,
    raw: AutomationTriggerCommand,
  ) {
    const input = yield* decodeCommand(raw).pipe(Effect.mapError(invalid));
    const owner = yield* gateway
      .identityForWrite(request, "access:write")
      .pipe(Effect.mapError(forbidden));
    const now = yield* Clock.currentTimeMillis;
    const before = input.op === "create" ? null : yield* read(input.bindingId);
    if (
      before &&
      (before.instanceId !== owner.instanceId || before.operatorId !== owner.operatorId)
    )
      return yield* forbidden();
    const identity =
      input.op === "activate" && before
        ? yield* worker.authorize(request, before.binding.target).pipe(Effect.mapError(forbidden))
        : null;
    if (identity && before) {
      if (
        before.binding.target.deviceId !== config.deviceId ||
        before.binding.target.environmentId !== config.environmentId
      )
        return yield* invalid();
      const target = {
        deviceId: before.binding.target.deviceId,
        environmentId: before.binding.target.environmentId,
      };
      const grant = yield* gateway
        .create(request, { ...target, scopes: ["orchestration:read"] })
        .pipe(Effect.mapError(forbidden));
      yield* Effect.gen(function* () {
        const snapshot = yield* gateway.projects(request, { ...target, grantId: grant.grantId });
        if (
          !snapshot.projects.some(
            (project) =>
              project.id === before.binding.target.projectId &&
              !project.deletedAt &&
              !project.archivedAt,
          )
        )
          return yield* invalid();
      }).pipe(
        Effect.ensuring(
          gateway.remove(request, { ...target, grantId: grant.grantId }).pipe(Effect.ignore),
        ),
        Effect.mapError(failure),
      );
    }
    const nextDueAt =
      input.op === "activate" && before?.binding.source.kind === "schedule"
        ? yield* config.nextSchedule(before.binding.source.config, now)
        : null;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted =
          yield* sql`INSERT INTO foundry_automation.trigger_commands(id,payload,result,instance_id,operator_id) VALUES(${input.commandId},${sql.json(input)},'{}'::jsonb,${owner.instanceId},${owner.operatorId}) ON CONFLICT DO NOTHING RETURNING id`;
        const commands = yield* sql<{
          same: boolean;
          result: unknown;
        }>`SELECT payload=${sql.json(input)}::jsonb AND instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} AS same,result FROM foundry_automation.trigger_commands WHERE id=${input.commandId}`;
        if (!commands[0]?.same) return yield* conflict();
        if (!inserted.length) return yield* decodeResult(commands[0].result);
        let id: string;
        if (input.op === "create") {
          if (
            input.target.deviceId !== config.deviceId ||
            input.target.environmentId !== config.environmentId
          )
            return yield* invalid();
          if (input.source.kind === "schedule")
            yield* config.nextSchedule(input.source.config, now);
          const definitions =
            yield* sql`SELECT d.id FROM foundry_automation.definition_versions d JOIN foundry_automation.definition_heads h ON h.version_id=d.id AND h.factory_id=d.factory_id JOIN foundry_automation.versions v ON v.id=d.factory_version_id WHERE d.id=${input.definitionVersionId} AND d.factory_id=${input.factoryId} AND ${input.repository}=ANY(v.repositories) AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.workflow_versions) w WHERE w->>'versionId'=${input.workflowVersionId}) FOR SHARE OF h`;
          if (!definitions.length) return yield* conflict();
          yield* sql`INSERT INTO foundry_automation.trigger_bindings(id,factory_id,instance_id,operator_id,definition_version_id,workflow_version_id,repository,source,target) VALUES(${input.id},${input.factoryId},${owner.instanceId},${owner.operatorId},${input.definitionVersionId},${input.workflowVersionId},${input.repository},${sql.json(input.source)},${sql.json(input.target)})`;
          id = input.id;
        } else {
          yield* sql`SELECT id FROM foundry_automation.trigger_bindings WHERE id=${input.bindingId} FOR UPDATE`;
          const current = yield* read(input.bindingId);
          if (
            current.binding.generation !== input.generation ||
            current.binding.state === "revoked"
          )
            return yield* conflict();
          id = input.bindingId;
          if (input.op === "activate") {
            if (
              !identity ||
              current.binding.state === "active" ||
              current.binding.state === "baselining"
            )
              return yield* conflict();
            const unattended = yield* decodeIdentity({
              authority: "unattended",
              instanceId: identity.instanceId,
              operatorId: identity.operatorId,
              deviceId: identity.deviceId,
              environmentId: identity.environmentId,
              deviceGeneration: identity.deviceGeneration,
              accessGeneration: identity.accessGeneration,
              automationGeneration: identity.automationGeneration,
              bindingId: id,
              bindingGeneration: input.generation,
              projectId: current.binding.target.projectId,
              workflowVersionId: current.binding.workflowVersionId,
            });
            const previous = yield* sql<{
              same: boolean;
            }>`SELECT identity=${sql.json(unattended)}::jsonb AS same FROM foundry_automation.unattended_grants WHERE binding_id=${id}`;
            if (previous.length && !previous[0]?.same) return yield* conflict();
            yield* sql`INSERT INTO foundry_automation.unattended_grants(binding_id,generation,identity) VALUES(${id},${input.generation},${sql.json(unattended)}) ON CONFLICT DO NOTHING`;
            const state = current.binding.source.kind === "github_issue" ? "baselining" : "active";
            yield* sql`UPDATE foundry_automation.trigger_bindings SET state=${state},activated_at=${now},next_due_at=${nextDueAt},next_poll_at=${now},cursor=${sql.json({ since: 0, page: 1, windowEnd: now })},reason=NULL,failures=0 WHERE id=${id}`;
          } else if (input.op === "deactivate") {
            yield* sql`UPDATE foundry_automation.trigger_bindings SET state='paused',reason=NULL WHERE id=${id}`;
            if (input.pending === "discard")
              yield* sql`UPDATE foundry_automation.trigger_events SET state='discarded',reason='trigger_deactivated' WHERE binding_id=${id} AND state IN ('accepted','blocked')`;
          } else {
            yield* sql`UPDATE foundry_automation.trigger_bindings SET state='revoked',reason='authorization_revoked' WHERE id=${id}`;
            yield* sql`UPDATE foundry_automation.unattended_grants SET enabled=false WHERE binding_id=${id}`;
            yield* sql`UPDATE foundry_automation.trigger_events SET state='blocked',reason='authorization_revoked' WHERE binding_id=${id} AND state='accepted'`;
          }
        }
        const result: AutomationTriggerResult = {
          kind: "binding",
          binding: (yield* read(id)).binding,
        };
        yield* sql`UPDATE foundry_automation.trigger_commands SET result=${sql.json(result)} WHERE id=${input.commandId}`;
        return result;
      }),
    );
  }, Effect.mapError(failure));
  const query = Effect.fn("Triggers.query")(function* (
    request: HttpServerRequest.HttpServerRequest,
    raw: AutomationTriggerQuery,
  ) {
    const input = yield* decodeQuery(raw).pipe(Effect.mapError(invalid));
    const owner = yield* gateway.identityForRead(request).pipe(Effect.mapError(forbidden));
    if (input.op === "bindings") {
      const rows =
        yield* sql`SELECT ${columns} FROM foundry_automation.trigger_bindings WHERE instance_id=${owner.instanceId} AND operator_id=${owner.operatorId} AND (${input.factoryId ?? null}::text IS NULL OR factory_id=${input.factoryId ?? null}) AND id>${input.after ?? ""} ORDER BY id LIMIT ${input.limit + 1}`;
      const items = yield* Effect.forEach(rows.slice(0, input.limit), (row) => decodeBinding(row));
      return {
        kind: "bindings" as const,
        items,
        next: rows.length > input.limit ? items.at(-1)!.id : null,
      };
    }
    const binding = yield* read(input.bindingId);
    if (binding.instanceId !== owner.instanceId || binding.operatorId !== owner.operatorId)
      return yield* forbidden();
    const rows =
      yield* sql`SELECT ${eventColumns} FROM foundry_automation.trigger_events WHERE binding_id=${input.bindingId} AND id>${input.after ?? ""} ORDER BY id LIMIT ${input.limit + 1}`;
    const items = yield* Effect.forEach(rows.slice(0, input.limit), (row) => decodeEvent(row));
    return {
      kind: "events" as const,
      items,
      next: rows.length > input.limit ? items.at(-1)!.id : null,
    };
  }, Effect.mapError(failure));
  const dueSchedules = Effect.fn("Triggers.dueSchedules")(function* (now: number, limit: number) {
    const rows =
      yield* sql`SELECT ${columns} FROM foundry_automation.trigger_bindings WHERE state='active' AND source->>'kind'='schedule' AND next_due_at<=${now} ORDER BY next_due_at,id LIMIT ${Math.min(50, Math.max(1, limit))}`;
    const bindings = yield* Effect.forEach(rows, (row) => decodeBinding(row));
    return bindings.flatMap((b) =>
      b.source.kind === "schedule" && b.nextDueAt !== null
        ? [{ id: b.id, generation: b.generation, config: b.source.config, nextDueAt: b.nextDueAt }]
        : [],
    );
  }, Effect.mapError(failure));
  const acceptScheduledBatch = Effect.fn("Triggers.acceptScheduledBatch")(function* (
    input: ScheduledBatch,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (
      input.occurrences.length > 10 ||
      input.nextDueAt <= now ||
      input.nextDueAt <= input.expectedNextDueAt ||
      ![0, 1].includes(input.skipped) ||
      input.occurrences.some(
        (o) => !Number.isFinite(o.dueAt) || o.dueAt < input.expectedNextDueAt || o.dueAt > now,
      )
    )
      return yield* invalid();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const locked =
          yield* sql`SELECT id FROM foundry_automation.trigger_bindings WHERE id=${input.bindingId} AND generation=${input.generation} AND state='active' AND source->>'kind'='schedule' AND next_due_at=${input.expectedNextDueAt} FOR UPDATE`;
        if (!locked.length) return false;
        for (const occurrence of input.occurrences) {
          yield* sql`INSERT INTO foundry_automation.trigger_events(id,binding_id,generation,deduplication_key,source,external_id,revision,title,occurred_at,received_at,payload,state) VALUES(${occurrence.id},${input.bindingId},${input.generation},${String(occurrence.dueAt)},'schedule',${String(occurrence.dueAt)},${String(occurrence.dueAt)},'Scheduled workflow',${occurrence.dueAt},${now},${sql.json({ dueAt: occurrence.dueAt })},'accepted') ON CONFLICT(binding_id,generation,deduplication_key) DO NOTHING`;
        }
        yield* sql`UPDATE foundry_automation.trigger_bindings SET next_due_at=${input.nextDueAt},skipped_ranges=skipped_ranges+${input.skipped} WHERE id=${input.bindingId}`;
        return true;
      }),
    );
  }, Effect.mapError(failure));
  const duePolls = Effect.fn("Triggers.duePolls")(function* (now: number, limit: number) {
    const rows =
      yield* sql`SELECT ${columns},cursor,failures FROM foundry_automation.trigger_bindings WHERE state IN ('active','baselining') AND source->>'kind'='github_issue' AND next_poll_at<=${now} ORDER BY next_poll_at,id LIMIT ${Math.min(50, Math.max(1, limit))}`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return {
          binding: yield* decodeBinding(row),
          cursor: yield* decodeCursor(row.cursor),
          failures: Number(row.failures),
        };
      }),
    );
  }, Effect.mapError(failure));
  const acceptIssueBatch = Effect.fn("Triggers.acceptIssueBatch")(function* (
    input: Parameters<Triggers["Service"]["acceptIssueBatch"]>[0],
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const locked = yield* sql<{
          state: string;
        }>`SELECT state FROM foundry_automation.trigger_bindings WHERE id=${input.bindingId} AND generation=${input.generation} AND state IN ('active','baselining') AND cursor=${sql.json(input.expectedCursor)}::jsonb FOR UPDATE`;
        if (!locked[0]) return false;
        if (input.issues.length > 100) return yield* invalid();
        const baseline = locked[0].state === "baselining";
        for (const issue of input.issues) {
          yield* sql`INSERT INTO foundry_automation.trigger_events(id,binding_id,generation,deduplication_key,source,external_id,revision,title,occurred_at,received_at,payload,state) VALUES(${issue.id},${input.bindingId},${input.generation},${issue.externalId},'github_issue',${issue.externalId},${issue.revision},${issue.title},${issue.occurredAt},${now},${sql.json(issue.payload)},${baseline ? "baseline" : "accepted"}) ON CONFLICT(binding_id,generation,deduplication_key) DO NOTHING`;
        }
        yield* sql`UPDATE foundry_automation.trigger_bindings SET cursor=${sql.json(input.nextCursor)},state=${baseline && !input.complete ? "baselining" : "active"},next_poll_at=${input.complete ? now + 60_000 : now},failures=0,reason=NULL WHERE id=${input.bindingId}`;
        return true;
      }),
    );
  }, Effect.mapError(failure));
  const pollFailed = Effect.fn("Triggers.pollFailed")(function* (
    input: Parameters<Triggers["Service"]["pollFailed"]>[0],
  ) {
    yield* sql`UPDATE foundry_automation.trigger_bindings SET failures=LEAST(failures+1,20),reason=${input.reason},next_poll_at=${input.retryAt} WHERE id=${input.bindingId} AND generation=${input.generation} AND cursor=${sql.json(input.expectedCursor)}::jsonb AND state IN ('active','baselining')`;
  }, Effect.mapError(failure));
  const admit = Effect.fn("Triggers.admit")(function* (eventId: string) {
    const rows = yield* sql<{
      bindingId: string;
    }>`SELECT binding_id AS "bindingId" FROM foundry_automation.trigger_events WHERE id=${eventId} AND state IN ('accepted','blocked')`;
    if (!rows[0]) return false;
    const saved = yield* read(rows[0].bindingId);
    const grant = yield* sql<{
      identity: unknown;
    }>`SELECT identity FROM foundry_automation.unattended_grants WHERE binding_id=${saved.binding.id} AND enabled`;
    if (!grant[0]) return false;
    const identity = yield* decodeIdentity(grant[0].identity);
    yield* grants.validate(identity).pipe(Effect.mapError(forbidden));
    // Network authorization happens before the short admission transaction; dispatch checks it again.
    yield* worker.status(identity).pipe(Effect.mapError(forbidden));
    const runId = `trigger:${yield* hash([saved.binding.id, saved.binding.generation, eventId])}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT id FROM foundry_automation.trigger_bindings WHERE id=${saved.binding.id} FOR UPDATE`;
        const events =
          yield* sql`SELECT ${eventColumns},payload FROM foundry_automation.trigger_events WHERE id=${eventId} AND state IN ('accepted','blocked') FOR UPDATE`;
        if (!events[0]) return false;
        const event = yield* decodeEvent(events[0]);
        const binding = (yield* read(saved.binding.id)).binding;
        if (!["active"].includes(binding.state)) return false;
        if (binding.source.kind === "schedule") {
          const running =
            yield* sql`SELECT t.run_id FROM foundry_automation.trigger_admissions t JOIN foundry_automation.dispatch_runs d ON d.run_id=t.run_id WHERE t.binding_id=${binding.id} AND d.state IN ('running','waiting') LIMIT 1`;
          if (running.length) {
            if (binding.source.config.overlap === "skip")
              yield* sql`UPDATE foundry_automation.trigger_events SET state='skipped',reason='overlap' WHERE id=${eventId}`;
            return false;
          }
        }
        const definitions = yield* sql<{
          factoryVersionId: string;
        }>`SELECT factory_version_id AS "factoryVersionId" FROM foundry_automation.definition_versions WHERE id=${binding.definitionVersionId}`;
        if (!definitions[0]) return yield* conflict();
        const workItemId = `work:${yield* hash([binding.id, binding.generation, event.externalId])}`;
        yield* factories.createWorkItem({
          commandId: `${workItemId}:create`,
          id: workItemId,
          factoryId: binding.factoryId,
          versionId: definitions[0].factoryVersionId,
          repository: binding.repository,
          title: event.title || "Triggered workflow",
          source: { kind: "external", reference: event.id },
        });
        yield* store.startTriggered(
          {
            commandId: `${runId}:start`,
            id: runId,
            factoryId: binding.factoryId,
            workItemId,
            workflowVersionId: binding.workflowVersionId,
            revision: event.revision,
          },
          binding.target.deviceId,
          {
            identity,
            projectId: binding.target.projectId,
            model: binding.target.model,
            triggerInput: {
              eventId: event.id,
              title: event.title,
              body:
                typeof events[0].payload === "object" &&
                events[0].payload !== null &&
                "body" in events[0].payload &&
                typeof events[0].payload.body === "string"
                  ? events[0].payload.body.slice(0, 16_000)
                  : "",
              reference:
                typeof events[0].payload === "object" &&
                events[0].payload !== null &&
                "reference" in events[0].payload &&
                typeof events[0].payload.reference === "string"
                  ? events[0].payload.reference
                  : event.externalId,
            },
            checks: binding.target.checks,
            requiredArtifacts: binding.target.requiredArtifacts,
          },
          { eventId, bindingId: binding.id, generation: binding.generation, identity },
        );
        return true;
      }),
    );
  }, Effect.mapError(failure));
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const pending = yield* sql<{
      id: string;
    }>`SELECT e.id FROM foundry_automation.trigger_events e JOIN foundry_automation.trigger_bindings b ON b.id=e.binding_id WHERE e.state IN ('accepted','blocked') AND b.state='active' AND e.next_attempt_at<=${now} ORDER BY e.next_attempt_at,e.received_at,e.id LIMIT 50`;
    let count = 0;
    for (const event of pending) {
      const accepted = yield* admit(event.id).pipe(
        Effect.catch((error) =>
          sql`UPDATE foundry_automation.trigger_events SET state='blocked',reason=${error.code} WHERE id=${event.id} AND state IN ('accepted','blocked')`.pipe(
            Effect.as(false),
          ),
        ),
      );
      if (accepted) count++;
      else
        yield* sql`UPDATE foundry_automation.trigger_events SET next_attempt_at=${now + 60_000} WHERE id=${event.id} AND state IN ('accepted','blocked')`;
    }
    return count;
  }).pipe(Effect.mapError(failure));
  return Triggers.of({
    command,
    query,
    dueSchedules,
    acceptScheduledBatch,
    duePolls,
    acceptIssueBatch,
    pollFailed,
    admit,
    tick,
  });
});
export const layer = Layer.effect(Triggers, make);
