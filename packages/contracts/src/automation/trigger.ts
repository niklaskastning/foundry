import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "../baseSchemas.ts";
import { FoundryDeviceId } from "../foundryDevices.ts";
import { ManualStart } from "./control.ts";
import { AutomationFactory } from "./factory.ts";

const Key = AutomationFactory.fields.id;
const Epoch = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Generation = Schema.Int.check(Schema.isGreaterThan(0));
export const AutomationScheduleConfig = Schema.Struct({
  timeZone: Key,
  timeOfDay: Schema.String.check(Schema.isPattern(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)),
  weekdays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(7),
    Schema.makeFilter((days) => new Set(days).size === days.length),
  ),
  catchUp: Schema.Literals(["skip", "latest", "bounded"]),
  maxCatchUp: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  overlap: Schema.Literals(["wait", "skip"]),
});
export type AutomationScheduleConfig = typeof AutomationScheduleConfig.Type;
export const AutomationTriggerSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github_issue"),
    connectionId: Key,
    repositoryId: Schema.Int.check(Schema.isGreaterThan(0)),
    repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
    label: Key,
  }),
  Schema.Struct({ kind: Schema.Literal("schedule"), config: AutomationScheduleConfig }),
]);
export const AutomationTriggerTarget = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  model: ManualStart.fields.model,
  checks: ManualStart.fields.checks,
  requiredArtifacts: ManualStart.fields.requiredArtifacts,
});
const BindingFields = {
  id: Key,
  factoryId: Key,
  definitionVersionId: Key,
  workflowVersionId: Key,
  repository: Key,
  source: AutomationTriggerSource,
  target: AutomationTriggerTarget,
};
export const AutomationTriggerBinding = Schema.Struct({
  ...BindingFields,
  generation: Generation,
  state: Schema.Literals(["inactive", "baselining", "active", "paused", "revoked"]),
  activatedAt: Schema.NullOr(Epoch),
  nextDueAt: Schema.NullOr(Epoch),
  nextPollAt: Epoch,
  reason: Schema.NullOr(Schema.String),
  skippedRanges: Schema.Int,
});
export type AutomationTriggerBinding = typeof AutomationTriggerBinding.Type;
export const AutomationTriggerEvent = Schema.Struct({
  id: Key,
  bindingId: Key,
  generation: Generation,
  deduplicationKey: Key,
  source: Schema.Literals(["github_issue", "schedule"]),
  externalId: Key,
  revision: Key,
  title: Schema.String.check(Schema.isMaxLength(500)),
  occurredAt: Epoch,
  receivedAt: Epoch,
  state: Schema.Literals(["accepted", "admitted", "baseline", "blocked", "discarded", "skipped"]),
  reason: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Key),
});
export type AutomationTriggerEvent = typeof AutomationTriggerEvent.Type;
export const AutomationTriggerCommand = Schema.Union([
  Schema.Struct({ op: Schema.Literal("create"), commandId: Key, ...BindingFields }),
  Schema.Struct({
    op: Schema.Literal("activate"),
    commandId: Key,
    bindingId: Key,
    generation: Generation,
  }),
  Schema.Struct({
    op: Schema.Literal("deactivate"),
    commandId: Key,
    bindingId: Key,
    generation: Generation,
    pending: Schema.Literals(["retain", "discard"]),
  }),
  Schema.Struct({
    op: Schema.Literal("revoke"),
    commandId: Key,
    bindingId: Key,
    generation: Generation,
  }),
]);
export type AutomationTriggerCommand = typeof AutomationTriggerCommand.Type;
const Page = {
  after: Schema.optional(Key),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
};
export const AutomationTriggerQuery = Schema.Union([
  Schema.Struct({ op: Schema.Literal("bindings"), factoryId: Schema.optional(Key), ...Page }),
  Schema.Struct({ op: Schema.Literal("events"), bindingId: Key, ...Page }),
]);
export type AutomationTriggerQuery = typeof AutomationTriggerQuery.Type;
export const AutomationTriggerResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("binding"), binding: AutomationTriggerBinding }),
  Schema.Struct({
    kind: Schema.Literal("bindings"),
    items: Schema.Array(AutomationTriggerBinding),
    next: Schema.NullOr(Key),
  }),
  Schema.Struct({
    kind: Schema.Literal("events"),
    items: Schema.Array(AutomationTriggerEvent),
    next: Schema.NullOr(Key),
  }),
]);
export type AutomationTriggerResult = typeof AutomationTriggerResult.Type;
export class AutomationTriggerError extends Schema.TaggedError<AutomationTriggerError>()(
  "AutomationTriggerError",
  {
    code: Schema.Literals([
      "forbidden",
      "invalid_input",
      "conflict",
      "not_found",
      "unavailable",
      "unsupported_provider",
      "worker_not_ready",
      "invalid_execution",
    ]),
  },
) {}
