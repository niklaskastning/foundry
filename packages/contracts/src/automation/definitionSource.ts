import * as Schema from "effect/Schema";
import { AutomationFactory } from "./factory.ts";
import { FactoryDefinitionFiles, FactoryDefinitionIssue } from "./definition.ts";

const Key = AutomationFactory.fields.id;
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const FactoryDefinitionGitLocation = Schema.Struct({
  connectionId: Schema.Literal("github-app"),
  repositoryId: Schema.Int.check(Schema.isGreaterThan(0)),
  repository: Schema.String.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ),
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  path: Schema.String.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/),
    Schema.makeFilter((path) => path.split("/").every((part) => part !== "." && part !== "..")),
  ),
});
export type FactoryDefinitionGitLocation = typeof FactoryDefinitionGitLocation.Type;
export const FactoryDefinitionSourceBinding = Schema.Struct({
  ...FactoryDefinitionGitLocation.fields,
  factoryId: Key,
  scopeVersionId: Key,
  instanceId: Schema.String,
  operatorId: Schema.String,
  appGeneration: Schema.Int,
  generation: Schema.Int,
  ownership: Schema.Literals(["pending", "git"]),
  enabled: Schema.Boolean,
  importVersionId: Schema.NullOr(Key),
  importContentHash: Schema.NullOr(Hash),
  selectedRevisionId: Schema.NullOr(Key),
  status: Schema.Literals(["pending", "ready", "invalid", "error", "paused"]),
  error: Schema.NullOr(Schema.String),
  nextSyncAt: Schema.Number,
});
export type FactoryDefinitionSourceBinding = typeof FactoryDefinitionSourceBinding.Type;
export const FactoryDefinitionGitRevision = Schema.Struct({
  id: Key,
  factoryId: Key,
  commitSha: Sha,
  contentHash: Schema.NullOr(Hash),
  valid: Schema.Boolean,
  issues: Schema.Array(FactoryDefinitionIssue),
  createdAt: Schema.Number,
});
export type FactoryDefinitionGitRevision = typeof FactoryDefinitionGitRevision.Type;
export const ConfigureDefinitionSource = Schema.Struct({
  expectedGeneration: Schema.optional(Schema.Int),
  commandId: Key,
  factoryId: Key,
  scopeVersionId: Key,
  expectedVersionId: Schema.NullOr(Key),
  expectedContentHash: Schema.NullOr(Hash),
  location: FactoryDefinitionGitLocation,
});
export const SyncDefinitionSource = Schema.Struct({
  commandId: Key,
  factoryId: Key,
  expectedGeneration: Schema.Int,
});
export const SetDefinitionSourceEnabled = Schema.Struct({
  ...SyncDefinitionSource.fields,
  enabled: Schema.Boolean,
});
export const ActivateDefinitionRevision = Schema.Struct({
  ...SyncDefinitionSource.fields,
  revisionId: Key,
  expectedVersionId: Schema.NullOr(Key),
});
export const DefinitionRevisionDetail = Schema.Struct({
  activeVersionId: Schema.NullOr(Key),
  revision: FactoryDefinitionGitRevision,
  files: FactoryDefinitionFiles,
  activeFiles: Schema.NullOr(FactoryDefinitionFiles),
});
