import * as Schema from "effect/Schema";
import { AutomationFactory, AutomationWorkflowVersion } from "./factory.ts";

const Key = AutomationFactory.fields.id;
const WorkflowKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/));
const DefinitionPath = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.ya?ml$/),
  Schema.makeFilter((path) => path.split("/").every((part) => part !== "." && part !== "..")),
);
const Repositories = Schema.Array(Key).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
export const FactoryDefinitionManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  factoryId: Key,
  repositories: Repositories,
  workflows: Schema.Array(Schema.Struct({ id: WorkflowKey, file: DefinitionPath })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.makeFilter(
      (values) =>
        new Set(values.map((item) => item.id)).size === values.length &&
        new Set(values.map((item) => item.file)).size === values.length,
    ),
  ),
});
export const FactoryWorkflowFile = Schema.Struct({ steps: AutomationWorkflowVersion.fields.steps });
export const CanonicalFactoryDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  factoryId: Key,
  repositories: Repositories,
  workflows: Schema.Array(
    Schema.Struct({ id: WorkflowKey, steps: AutomationWorkflowVersion.fields.steps }),
  ),
});
export type CanonicalFactoryDefinition = typeof CanonicalFactoryDefinition.Type;
export const FactoryDefinitionFiles = Schema.Array(
  Schema.Struct({
    path: DefinitionPath,
    content: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(101));
export type FactoryDefinitionFiles = typeof FactoryDefinitionFiles.Type;
export const FactoryDefinitionIssue = Schema.Struct({
  file: Schema.String,
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String,
});
export type FactoryDefinitionIssue = typeof FactoryDefinitionIssue.Type;
const LocalFactoryDefinitionSource = Schema.Struct({
  kind: Schema.Literals(["foundry", "files"]),
  reference: Key,
});
export const FactoryDefinitionSource = Schema.Union([
  LocalFactoryDefinitionSource,
  Schema.Struct({
    kind: Schema.Literal("github"),
    reference: Key,
    repositoryId: Schema.Int,
    repository: Schema.String,
    branch: Schema.String,
    path: Schema.String,
    commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  }),
]);
export const FactoryDefinitionVersion = Schema.Struct({
  id: Key,
  commandId: Key,
  factoryId: Key,
  factoryVersionId: Key,
  scopeVersionId: Key,
  contentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  source: FactoryDefinitionSource,
  definition: CanonicalFactoryDefinition,
  workflowVersions: Schema.Array(Schema.Struct({ id: WorkflowKey, versionId: Key })),
});
export type FactoryDefinitionVersion = typeof FactoryDefinitionVersion.Type;
export const ActivateFactoryDefinition = Schema.Struct({
  commandId: Key,
  factoryId: Key,
  scopeVersionId: Key,
  expectedVersionId: Schema.NullOr(Key),
  files: FactoryDefinitionFiles,
  source: LocalFactoryDefinitionSource,
});
