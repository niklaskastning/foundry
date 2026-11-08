import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "../baseSchemas.ts";
import { FoundryDeviceId } from "../foundryDevices.ts";
const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
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
  model: Key,
  checks: Schema.Array(Schema.Struct({ id: Text, prompt: Text, command: Text, cwd: Text })).check(
    Schema.isMaxLength(100),
  ),
  requiredArtifacts: Schema.Array(
    Schema.Struct({ stepId: Text, names: Schema.Array(Text).check(Schema.isMaxLength(100)) }),
  ).check(Schema.isMaxLength(100)),
});
