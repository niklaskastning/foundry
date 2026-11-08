import { AutomationTriggerTarget } from "./triggerConfiguration.ts";
import { FoundrySandboxProfile } from "../foundrySandbox.ts";
import * as Schema from "effect/Schema";
import { StartAutomationRun } from "./factory.ts";
import { FoundryDeviceId } from "../foundryDevices.ts";
import { EnvironmentId } from "../baseSchemas.ts";
import { ProjectId } from "../baseSchemas.ts";
import { ProviderUserInputAnswers } from "../providerPolicy.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Base = { commandId: Key, factoryId: Key, runId: Key, expectedRevision: Revision };
export const AutomationControlCommand = Schema.Union([
  Schema.Struct({ ...Base, action: Schema.Literals(["pause", "resume", "cancel", "retry"]) }),
  Schema.Struct({
    ...Base,
    action: Schema.Literals(["approve", "reject"]),
    stepId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    resultRevision: Revision,
  }),
  Schema.Struct({
    ...Base,
    action: Schema.Literal("answer"),
    requestId: Key,
    attemptCommandId: Schema.optional(Key),
    questionRevision: Schema.optional(Key),
    resultRevision: Revision,
    answers: ProviderUserInputAnswers,
  }),
]);
export type AutomationControlCommand = typeof AutomationControlCommand.Type;
export const AutomationControlSnapshot = Schema.Struct({
  factoryId: Key,
  runId: Key,
  revision: Revision,
  resultRevision: Revision,
  state: Schema.Literals([
    "running",
    "waiting",
    "paused",
    "cancel_requested",
    "cancelled",
    "failed",
    "succeeded",
  ]),
  reason: Schema.NullOr(Schema.String),
});
export type AutomationControlSnapshot = typeof AutomationControlSnapshot.Type;
export class AutomationControlError extends Schema.TaggedError<AutomationControlError>()(
  "AutomationControlError",
  {
    code: Schema.Literals([
      "forbidden",
      "not_found",
      "conflict",
      "invalid_transition",
      "writer_not_ended",
      "unavailable",
    ]),
  },
) {}
export const AutomationWorkerTarget = Schema.Struct({
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export const ManualStart = Schema.Struct({
  ...StartAutomationRun.fields,
  sandbox: Schema.optional(
    Schema.Struct({
      profileId: FoundrySandboxProfile.fields.profileId,
      revision: FoundrySandboxProfile.fields.revision,
    }),
  ),
  projectId: ProjectId,
  workers: Schema.optional(
    Schema.Array(AutomationWorkerTarget).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  model: AutomationTriggerTarget.fields.model,
  checks: AutomationTriggerTarget.fields.checks,
  requiredArtifacts: AutomationTriggerTarget.fields.requiredArtifacts,
});
export type ManualStart = typeof ManualStart.Type;
