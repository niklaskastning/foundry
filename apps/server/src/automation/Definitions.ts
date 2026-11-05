import {
  ActivateFactoryDefinition,
  FactoryDefinitionIssue,
  type FactoryDefinitionVersion,
  type FactoryDefinitionFiles,
  type FactoryDefinitionGitLocation,
} from "@t3tools/contracts";
import {
  canonicalFactoryJson,
  exportFactoryFiles,
  validateFactoryFiles,
} from "@t3tools/shared/factoryDefinition";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as Factories from "./Factories.ts";
import * as Workflows from "./Workflows.ts";

export class DefinitionError extends Schema.TaggedError<DefinitionError>()("DefinitionError", {
  reason: Schema.Literals([
    "invalid_input",
    "invalid_definition",
    "not_found",
    "scope_mismatch",
    "archived",
    "version_conflict",
    "command_conflict",
    "unavailable",
  ]),
  issues: Schema.optional(Schema.Array(FactoryDefinitionIssue)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Factory definition operation failed (${this.reason}).`;
  }
}
const isDefinitionError = Schema.is(DefinitionError);
const isAutomationError = Schema.is(Factories.AutomationError);
const operationError = (cause: unknown) =>
  isDefinitionError(cause)
    ? cause
    : new DefinitionError({
        reason: isAutomationError(cause) ? cause.reason : "unavailable",
        cause,
      });
const decodeActivation = Schema.decodeEffect(ActivateFactoryDefinition, {
  onExcessProperty: "error",
});

export class Definitions extends Context.Service<
  Definitions,
  {
    readonly activate: (
      input: typeof ActivateFactoryDefinition.Type,
    ) => Effect.Effect<FactoryDefinitionVersion, DefinitionError>;
    readonly activateGit: (input: {
      factoryId: string;
      revisionId: string;
      expectedGeneration: number;
      expectedVersionId: string | null;
    }) => Effect.Effect<FactoryDefinitionVersion, DefinitionError>;
    readonly readVersion: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<FactoryDefinitionVersion, DefinitionError>;
    readonly active: (
      factoryId: string,
    ) => Effect.Effect<Option.Option<FactoryDefinitionVersion>, DefinitionError>;
    readonly exportVersion: (
      factoryId: string,
      id: string,
    ) => Effect.Effect<FactoryDefinitionFiles, DefinitionError>;
  }
>()("t3/automation/Definitions") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const factories = yield* Factories.Factories;
  const workflows = yield* Workflows.Workflows;
  const crypto = yield* Crypto.Crypto;
  const hash = Effect.fn("Definitions.hash")((value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(Hex.encode)),
  );
  const readVersion = Effect.fn("Definitions.readVersion")(function* (
    factoryId: string,
    id: string,
  ) {
    const rows =
      yield* sql<FactoryDefinitionVersion>`SELECT id,command_id AS "commandId",factory_id AS "factoryId",factory_version_id AS "factoryVersionId",scope_version_id AS "scopeVersionId",content_hash AS "contentHash",source,definition,workflow_versions AS "workflowVersions" FROM foundry_automation.definition_versions WHERE factory_id=${factoryId} AND id=${id}`;
    if (!rows[0]) return yield* new DefinitionError({ reason: "not_found" });
    return rows[0];
  }, Effect.mapError(operationError));
  const active = Effect.fn("Definitions.active")(function* (factoryId: string) {
    yield* factories.readFactory(factoryId);
    const rows = yield* sql<{
      versionId: string;
    }>`SELECT version_id AS "versionId" FROM foundry_automation.definition_heads WHERE factory_id=${factoryId}`;
    return rows[0] ? Option.some(yield* readVersion(factoryId, rows[0].versionId)) : Option.none();
  }, Effect.mapError(operationError));
  const activateSnapshot = Effect.fn("Definitions.activateSnapshot")(function* (
    input: Omit<typeof ActivateFactoryDefinition.Type, "source"> & {
      source: FactoryDefinitionVersion["source"];
    },
  ) {
    const parsed = validateFactoryFiles(input.files);
    if (Result.isFailure(parsed))
      return yield* new DefinitionError({ reason: "invalid_definition", issues: parsed.failure });
    const definition = parsed.success;
    if (definition.factoryId !== input.factoryId)
      return yield* new DefinitionError({ reason: "scope_mismatch" });
    const contentHash = yield* hash(canonicalFactoryJson(definition));
    const commandHash = yield* hash(input.commandId);
    const id = `definition:${commandHash}`;
    const factoryVersionId = `definition-factory:${commandHash}`;
    const payload = {
      factoryId: input.factoryId,
      scopeVersionId: input.scopeVersionId,
      expectedVersionId: input.expectedVersionId,
      contentHash,
      source: input.source,
    };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted =
          yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${input.commandId},'definitionActivation',${sql.json(payload)}) ON CONFLICT DO NOTHING RETURNING id`;
        const commands = yield* sql<{
          same: boolean;
        }>`SELECT kind='definitionActivation' AND payload=${sql.json(payload)}::jsonb AS same FROM foundry_automation.commands WHERE id=${input.commandId}`;
        if (commands[0]?.same !== true)
          return yield* new DefinitionError({ reason: "command_conflict" });
        if (!inserted.length) return yield* readVersion(input.factoryId, id);
        const locked =
          yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${input.factoryId} FOR UPDATE`;
        if (!locked.length) return yield* new DefinitionError({ reason: "not_found" });
        const ownership = yield* sql<{
          ownership: string;
        }>`SELECT ownership FROM foundry_automation.definition_sources WHERE factory_id=${input.factoryId}`;
        if (input.source.kind !== "github" && ownership[0]?.ownership === "git")
          return yield* new DefinitionError({ reason: "version_conflict" });
        const current = yield* active(input.factoryId);
        if ((Option.isSome(current) ? current.value.id : null) !== input.expectedVersionId)
          return yield* new DefinitionError({ reason: "version_conflict" });
        const scope = yield* factories.readVersion(input.factoryId, input.scopeVersionId);
        if (definition.repositories.some((repository) => !scope.repositories.includes(repository)))
          return yield* new DefinitionError({ reason: "scope_mismatch" });
        yield* factories.createVersion({
          commandId: factoryVersionId,
          id: factoryVersionId,
          factoryId: input.factoryId,
          repositories: definition.repositories,
        });
        const workflowVersions: Array<FactoryDefinitionVersion["workflowVersions"][number]> = [];
        for (const workflow of definition.workflows) {
          const versionId = `definition-workflow:${commandHash}:${workflow.id}`;
          yield* workflows.createVersion({
            commandId: versionId,
            id: versionId,
            factoryId: input.factoryId,
            factoryVersionId,
            steps: workflow.steps,
          });
          workflowVersions.push({ id: workflow.id, versionId });
        }
        yield* sql`INSERT INTO foundry_automation.definition_versions(id,command_id,factory_id,factory_version_id,scope_version_id,content_hash,source,definition,workflow_versions) VALUES(${id},${input.commandId},${input.factoryId},${factoryVersionId},${input.scopeVersionId},${contentHash},${sql.json(input.source)},${sql.json(definition)},${sql.json(workflowVersions)})`;
        yield* sql`INSERT INTO foundry_automation.definition_heads(factory_id,version_id) VALUES(${input.factoryId},${id}) ON CONFLICT(factory_id) DO UPDATE SET version_id=EXCLUDED.version_id`;
        return yield* readVersion(input.factoryId, id);
      }),
    );
  }, Effect.mapError(operationError));
  const activate = Effect.fn("Definitions.activate")(function* (
    raw: typeof ActivateFactoryDefinition.Type,
  ) {
    const input = yield* decodeActivation(raw).pipe(
      Effect.mapError((cause) => new DefinitionError({ reason: "invalid_input", cause })),
    );
    return yield* activateSnapshot(input);
  });
  const activateGit = Effect.fn("Definitions.activateGit")(function* (input: {
    factoryId: string;
    revisionId: string;
    expectedGeneration: number;
    expectedVersionId: string | null;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${input.factoryId} FOR UPDATE`;
        const bindings = yield* sql<{
          location: FactoryDefinitionGitLocation;
          scopeVersionId: string;
          ownership: string;
          importVersionId: string | null;
          importContentHash: string | null;
        }>`SELECT location,scope_version_id AS "scopeVersionId",ownership,import_version_id AS "importVersionId",import_content_hash AS "importContentHash" FROM foundry_automation.definition_sources WHERE factory_id=${input.factoryId} AND enabled AND generation=${input.expectedGeneration}`;
        const revisions = yield* sql<{
          files: FactoryDefinitionFiles;
          commitSha: string;
          contentHash: string;
        }>`SELECT files,commit_sha AS "commitSha",content_hash AS "contentHash" FROM foundry_automation.definition_git_revisions WHERE factory_id=${input.factoryId} AND id=${input.revisionId} AND valid`;
        const binding = bindings[0];
        const revision = revisions[0];
        if (!binding || !revision)
          return yield* new DefinitionError({ reason: "version_conflict" });
        const current = yield* active(input.factoryId);
        if ((Option.getOrNull(current)?.id ?? null) !== input.expectedVersionId)
          return yield* new DefinitionError({ reason: "version_conflict" });
        if (
          binding.ownership === "pending" &&
          ((Option.getOrNull(current)?.id ?? null) !== binding.importVersionId ||
            (Option.getOrNull(current)?.contentHash ?? null) !== binding.importContentHash ||
            (binding.importContentHash !== null &&
              revision.contentHash !== binding.importContentHash))
        )
          return yield* new DefinitionError({ reason: "version_conflict" });
        const existing = yield* sql<{
          id: string;
        }>`SELECT id FROM foundry_automation.definition_versions WHERE factory_id=${input.factoryId} AND source->>'kind'='github' AND source->>'reference'=${input.revisionId}`;
        if (existing[0]) {
          yield* sql`UPDATE foundry_automation.definition_heads SET version_id=${existing[0].id} WHERE factory_id=${input.factoryId}`;
          return yield* readVersion(input.factoryId, existing[0].id);
        }
        return yield* activateSnapshot({
          commandId: `git-definition:${input.revisionId}`,
          factoryId: input.factoryId,
          scopeVersionId: binding.scopeVersionId,
          expectedVersionId: input.expectedVersionId,
          files: revision.files,
          source: {
            kind: "github",
            reference: input.revisionId,
            repositoryId: binding.location.repositoryId,
            repository: binding.location.repository,
            branch: binding.location.branch,
            path: binding.location.path,
            commitSha: revision.commitSha,
          },
        });
      }),
    );
  }, Effect.mapError(operationError));
  const exportVersion = Effect.fn("Definitions.exportVersion")(function* (
    factoryId: string,
    id: string,
  ) {
    return exportFactoryFiles((yield* readVersion(factoryId, id)).definition);
  });
  return Definitions.of({ activate, activateGit, readVersion, active, exportVersion });
});
export const layer = Layer.effect(Definitions, make);
