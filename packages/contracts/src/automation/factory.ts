import * as Schema from "effect/Schema";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const AutomationFactory = Schema.Struct({
  id: Key,
  name: Title,
  archived: Schema.Boolean,
});
export type AutomationFactory = typeof AutomationFactory.Type;
export const AutomationFactoryVersion = Schema.Struct({
  id: Key,
  factoryId: Key,
  repositories: Schema.Array(Key),
});
export type AutomationFactoryVersion = typeof AutomationFactoryVersion.Type;
export const AutomationWorkItemState = Schema.Literals([
  "open",
  "in_progress",
  "review",
  "completed",
  "cancelled",
]);
export const AutomationWorkItem = Schema.Struct({
  id: Key,
  factoryId: Key,
  versionId: Key,
  repository: Key,
  title: Title,
  source: Schema.Struct({ kind: Schema.Literals(["manual", "external"]), reference: Key }),
  state: AutomationWorkItemState,
});
export type AutomationWorkItem = typeof AutomationWorkItem.Type;
export const CreateAutomationFactory = Schema.Struct({ commandId: Key, id: Key, name: Title });
export const CreateAutomationVersion = Schema.Struct({
  commandId: Key,
  id: Key,
  factoryId: Key,
  repositories: Schema.Array(Key),
});
export const CreateAutomationWorkItem = Schema.Struct({
  commandId: Key,
  id: Key,
  factoryId: Key,
  versionId: Key,
  repository: Key,
  title: Title,
  source: AutomationWorkItem.fields.source,
});
