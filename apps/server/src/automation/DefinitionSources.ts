import {
  ActivateDefinitionRevision,
  ConfigureDefinitionSource,
  SyncDefinitionSource,
  SetDefinitionSourceEnabled,
  FactoryDefinitionSourceBinding,
  FactoryDefinitionGitRevision,
  FactoryDefinitionFiles,
  type DefinitionRevisionDetail,
  type FactoryDefinitionVersion,
} from "@t3tools/contracts";
import { canonicalFactoryJson, validateFactoryFiles } from "@t3tools/shared/factoryDefinition";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Database from "./AutomationDatabase.ts";
import * as Definitions from "./Definitions.ts";
import * as GitHubApp from "./GitHubApp.ts";

const decodeBinding = Schema.decodeEffect(FactoryDefinitionSourceBinding);
const decodeConfigure = Schema.decodeEffect(ConfigureDefinitionSource);
const decodeSync = Schema.decodeEffect(SyncDefinitionSource);
const decodeEnabled = Schema.decodeEffect(SetDefinitionSourceEnabled);
const decodeActivate = Schema.decodeEffect(ActivateDefinitionRevision);
const decodeFiles = Schema.decodeEffect(FactoryDefinitionFiles);
const decodeSha = Schema.decodeEffect(FactoryDefinitionGitRevision.fields.commitSha);

type Binding = FactoryDefinitionSourceBinding;
type Identity = { instanceId: string; operatorId: string };
export class DefinitionSourceError extends Schema.TaggedError<DefinitionSourceError>()(
  "DefinitionSourceError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "not_found",
      "forbidden",
      "version_conflict",
      "command_conflict",
      "invalid_definition",
      "unavailable",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isSourceError = Schema.is(DefinitionSourceError);
const isDefinitionError = Schema.is(Definitions.DefinitionError);
const operationError = (cause: unknown) => {
  if (isSourceError(cause)) return cause;
  if (isDefinitionError(cause))
    return new DefinitionSourceError({
      reason:
        cause.reason === "scope_mismatch"
          ? "invalid_definition"
          : cause.reason === "archived"
            ? "forbidden"
            : cause.reason,
      cause,
    });
  return new DefinitionSourceError({ reason: "unavailable", cause });
};
export class DefinitionSources extends Context.Service<
  DefinitionSources,
  {
    readonly configure: (
      input: typeof ConfigureDefinitionSource.Type,
      identity: Identity,
    ) => Effect.Effect<Binding, DefinitionSourceError>;
    readonly requestSync: (
      input: typeof SyncDefinitionSource.Type,
      identity: Identity,
    ) => Effect.Effect<Binding, DefinitionSourceError>;
    readonly setEnabled: (
      input: typeof SetDefinitionSourceEnabled.Type,
      identity: Identity,
    ) => Effect.Effect<Binding, DefinitionSourceError>;
    readonly activateRevision: (
      input: typeof ActivateDefinitionRevision.Type,
      identity: Identity,
    ) => Effect.Effect<FactoryDefinitionVersion, DefinitionSourceError>;
    readonly source: (factoryId: string) => Effect.Effect<Binding | null, DefinitionSourceError>;
    readonly listRevisions: (
      factoryId: string,
      after: string | undefined,
      limit: number,
    ) => Effect.Effect<
      { items: readonly FactoryDefinitionGitRevision[]; next: string | null },
      DefinitionSourceError
    >;
    readonly readRevision: (
      factoryId: string,
      revisionId: string,
    ) => Effect.Effect<typeof DefinitionRevisionDetail.Type, DefinitionSourceError>;
    readonly due: (
      now: number,
      limit: number,
    ) => Effect.Effect<readonly Binding[], DefinitionSourceError>;
    readonly accept: (
      binding: Binding,
      result: { commitSha: string; files: FactoryDefinitionFiles },
      now: number,
    ) => Effect.Effect<void, DefinitionSourceError>;
    readonly fail: (
      binding: Binding,
      reason: string,
      nextSyncAt: number,
    ) => Effect.Effect<void, DefinitionSourceError>;
  }
>()("t3/automation/DefinitionSources") {}

const make = Effect.gen(function* () {
  const sql = yield* Database.AutomationDatabase;
  const definitions = yield* Definitions.Definitions;
  const github = yield* GitHubApp.GitHubApp;
  const crypto = yield* Crypto.Crypto;
  const hash = Effect.fn("DefinitionSources.hash")((value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(Hex.encode)),
  );
  const source = Effect.fn("DefinitionSources.source")(function* (factoryId: string) {
    const rows = yield* sql<{
      value: Binding;
    }>`SELECT location || jsonb_build_object('factoryId',factory_id,'scopeVersionId',scope_version_id,'instanceId',instance_id,'operatorId',operator_id,'appGeneration',app_generation,'generation',generation,'ownership',ownership,'enabled',enabled,'importVersionId',import_version_id,'importContentHash',import_content_hash,'selectedRevisionId',selected_revision_id,'status',status,'error',error,'nextSyncAt',next_sync_at) AS value FROM foundry_automation.definition_sources WHERE factory_id=${factoryId}`;
    return rows[0] ? yield* decodeBinding(rows[0].value) : null;
  }, Effect.mapError(operationError));
  const requireSource = Effect.fn("DefinitionSources.requireSource")(function* (factoryId: string) {
    const value = yield* source(factoryId);
    if (!value) return yield* new DefinitionSourceError({ reason: "not_found" });
    return value;
  });
  const lock = Effect.fn("DefinitionSources.lock")(function* (factoryId: string) {
    const rows =
      yield* sql`SELECT id FROM foundry_automation.factories WHERE id=${factoryId} FOR UPDATE`;
    if (!rows.length) return yield* new DefinitionSourceError({ reason: "not_found" });
  });
  const grant = Effect.fn("DefinitionSources.grant")(function* (
    binding: Pick<Binding, "repository" | "repositoryId" | "connectionId">,
    generation?: number,
  ) {
    const current = yield* github
      .binding(binding.repository)
      .pipe(Effect.mapError((cause) => new DefinitionSourceError({ reason: "forbidden", cause })));
    if (
      current.repository !== binding.repository ||
      current.repositoryId !== binding.repositoryId ||
      current.connectionId !== binding.connectionId ||
      (generation !== undefined && current.generation !== generation)
    )
      return yield* new DefinitionSourceError({ reason: "forbidden" });
    return current.generation;
  });
  const authorize = Effect.fn("DefinitionSources.authorize")(function* (
    binding: Binding,
    identity: Identity,
    reauthorize = false,
  ) {
    if (binding.instanceId !== identity.instanceId || binding.operatorId !== identity.operatorId)
      return yield* new DefinitionSourceError({ reason: "forbidden" });
    return yield* grant(binding, reauthorize ? undefined : binding.appGeneration);
  });
  const replay = Effect.fn("DefinitionSources.replay")(function* <A>(
    commandId: string,
    payload: unknown,
    identity: Identity,
  ) {
    const rows = yield* sql<{
      same: boolean;
      result: A;
    }>`SELECT payload=${sql.json(payload)}::jsonb AND instance_id=${identity.instanceId} AND operator_id=${identity.operatorId} AS same,result FROM foundry_automation.definition_source_commands WHERE id=${commandId}`;
    if (rows[0] && !rows[0].same)
      return yield* new DefinitionSourceError({ reason: "command_conflict" });
    return rows[0] ? Option.some(rows[0].result) : Option.none<A>();
  });
  const receipt = Effect.fn("DefinitionSources.receipt")(function* <A>(
    commandId: string,
    payload: unknown,
    identity: Identity,
    result: A,
  ) {
    yield* sql`INSERT INTO foundry_automation.definition_source_commands(id,payload,result,instance_id,operator_id) VALUES(${commandId},${sql.json(payload)},${sql.json(result)},${identity.instanceId},${identity.operatorId})`;
    return result;
  });
  const configure = Effect.fn("DefinitionSources.configure")(function* (
    raw: typeof ConfigureDefinitionSource.Type,
    identity: Identity,
  ) {
    const input = yield* decodeConfigure(raw).pipe(
      Effect.mapError((cause) => new DefinitionSourceError({ reason: "invalid_input", cause })),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(input.factoryId);
        const generation = yield* grant(input.location);
        const existing = yield* source(input.factoryId);
        if (existing) yield* authorize(existing, identity);
        const payload = { op: "configure", ...input };
        const previous = yield* replay<Binding>(input.commandId, payload, identity);
        if (Option.isSome(previous)) return previous.value;
        if (
          existing &&
          (existing.generation !== input.expectedGeneration ||
            existing.scopeVersionId !== input.scopeVersionId)
        )
          return yield* new DefinitionSourceError({ reason: "version_conflict" });
        const current = Option.getOrNull(yield* definitions.active(input.factoryId));
        if (
          (current?.id ?? null) !== input.expectedVersionId ||
          (current?.contentHash ?? null) !== input.expectedContentHash
        )
          return yield* new DefinitionSourceError({ reason: "version_conflict" });
        const scopes =
          yield* sql`SELECT id FROM foundry_automation.versions WHERE factory_id=${input.factoryId} AND id=${input.scopeVersionId}`;
        if (!scopes.length) return yield* new DefinitionSourceError({ reason: "not_found" });
        if (existing) {
          yield* sql`UPDATE foundry_automation.definition_sources SET location=${sql.json(input.location)},app_generation=${generation},import_version_id=${input.expectedVersionId},import_content_hash=${input.expectedContentHash},generation=generation+1,selected_revision_id=NULL,status='pending',error=NULL,next_sync_at=0 WHERE factory_id=${input.factoryId}`;
        } else
          yield* sql`INSERT INTO foundry_automation.definition_sources(factory_id,location,scope_version_id,instance_id,operator_id,app_generation,import_version_id,import_content_hash) VALUES(${input.factoryId},${sql.json(input.location)},${input.scopeVersionId},${identity.instanceId},${identity.operatorId},${generation},${input.expectedVersionId},${input.expectedContentHash})`;
        return yield* receipt(
          input.commandId,
          payload,
          identity,
          yield* requireSource(input.factoryId),
        );
      }),
    );
  }, Effect.mapError(operationError));
  const change = Effect.fn("DefinitionSources.change")(function* (
    input: typeof SyncDefinitionSource.Type & { enabled?: boolean },
    identity: Identity,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(input.factoryId);
        const binding = yield* requireSource(input.factoryId);
        if (
          binding.instanceId !== identity.instanceId ||
          binding.operatorId !== identity.operatorId
        )
          return yield* new DefinitionSourceError({ reason: "forbidden" });
        const appGeneration =
          input.enabled === false
            ? binding.appGeneration
            : yield* authorize(binding, identity, input.enabled === true);
        if (input.enabled === undefined && !binding.enabled)
          return yield* new DefinitionSourceError({ reason: "forbidden" });
        const payload = { op: input.enabled === undefined ? "sync" : "enabled", ...input };
        const previous = yield* replay<Binding>(input.commandId, payload, identity);
        if (Option.isSome(previous)) return previous.value;
        if (binding.generation !== input.expectedGeneration)
          return yield* new DefinitionSourceError({ reason: "version_conflict" });
        const enabled = input.enabled ?? binding.enabled;
        yield* sql`UPDATE foundry_automation.definition_sources SET generation=generation+1,app_generation=${appGeneration},enabled=${enabled},status=${enabled ? "pending" : "paused"},error=NULL,next_sync_at=0 WHERE factory_id=${input.factoryId}`;
        return yield* receipt(
          input.commandId,
          payload,
          identity,
          yield* requireSource(input.factoryId),
        );
      }),
    );
  }, Effect.mapError(operationError));
  const requestSync = Effect.fn("DefinitionSources.requestSync")(function* (
    raw: typeof SyncDefinitionSource.Type,
    identity: Identity,
  ) {
    return yield* change(
      yield* decodeSync(raw).pipe(
        Effect.mapError((cause) => new DefinitionSourceError({ reason: "invalid_input", cause })),
      ),
      identity,
    );
  }, Effect.mapError(operationError));
  const setEnabled = Effect.fn("DefinitionSources.setEnabled")(function* (
    raw: typeof SetDefinitionSourceEnabled.Type,
    identity: Identity,
  ) {
    return yield* change(
      yield* decodeEnabled(raw).pipe(
        Effect.mapError((cause) => new DefinitionSourceError({ reason: "invalid_input", cause })),
      ),
      identity,
    );
  }, Effect.mapError(operationError));
  const readRevision = Effect.fn("DefinitionSources.readRevision")(function* (
    factoryId: string,
    revisionId: string,
  ) {
    const rows = yield* sql<
      FactoryDefinitionGitRevision & { files: FactoryDefinitionFiles }
    >`SELECT id,factory_id AS "factoryId",commit_sha AS "commitSha",content_hash AS "contentHash",valid,issues,created_at::float8 AS "createdAt",location,files FROM foundry_automation.definition_git_revisions WHERE factory_id=${factoryId} AND id=${revisionId}`;
    if (!rows[0]) return yield* new DefinitionSourceError({ reason: "not_found" });
    const { files, ...revision } = rows[0];
    const current = Option.getOrNull(yield* definitions.active(factoryId));
    return {
      revision,
      files,
      activeVersionId: current?.id ?? null,
      activeFiles: current ? yield* definitions.exportVersion(factoryId, current.id) : null,
    };
  }, Effect.mapError(operationError));
  const activateRevision = Effect.fn("DefinitionSources.activateRevision")(function* (
    raw: typeof ActivateDefinitionRevision.Type,
    identity: Identity,
  ) {
    const input = yield* decodeActivate(raw).pipe(
      Effect.mapError((cause) => new DefinitionSourceError({ reason: "invalid_input", cause })),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(input.factoryId);
        const binding = yield* requireSource(input.factoryId);
        yield* authorize(binding, identity);
        if (!binding.enabled) return yield* new DefinitionSourceError({ reason: "forbidden" });
        const payload = { op: "activate", ...input };
        const previous = yield* replay<FactoryDefinitionVersion>(
          input.commandId,
          payload,
          identity,
        );
        if (Option.isSome(previous)) return previous.value;
        if (binding.generation !== input.expectedGeneration)
          return yield* new DefinitionSourceError({ reason: "version_conflict" });
        const { revision } = yield* readRevision(input.factoryId, input.revisionId);
        if (!revision.valid)
          return yield* new DefinitionSourceError({ reason: "invalid_definition" });
        if (binding.ownership === "pending") {
          const current = Option.getOrNull(yield* definitions.active(input.factoryId));
          if (
            (current?.id ?? null) !== binding.importVersionId ||
            (current?.contentHash ?? null) !== binding.importContentHash ||
            (binding.importContentHash !== null &&
              revision.contentHash !== binding.importContentHash)
          )
            return yield* new DefinitionSourceError({ reason: "version_conflict" });
        }
        const result = yield* definitions.activateGit(input);
        yield* sql`UPDATE foundry_automation.definition_sources SET ownership='git',generation=generation+1 WHERE factory_id=${input.factoryId}`;
        return yield* receipt(input.commandId, payload, identity, result);
      }),
    );
  }, Effect.mapError(operationError));
  const due = Effect.fn("DefinitionSources.due")(function* (now: number, limit: number) {
    const rows = yield* sql<{
      id: string;
    }>`SELECT factory_id AS id FROM foundry_automation.definition_sources WHERE enabled AND next_sync_at<=${now} ORDER BY next_sync_at,factory_id LIMIT ${Math.max(1, Math.min(100, limit))}`;
    return yield* Effect.forEach(rows, (row) => requireSource(row.id));
  }, Effect.mapError(operationError));
  const accept = Effect.fn("DefinitionSources.accept")(function* (
    binding: Binding,
    result: { commitSha: string; files: FactoryDefinitionFiles },
    now: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(binding.factoryId);
        const current = yield* requireSource(binding.factoryId);
        if (
          !current.enabled ||
          current.generation !== binding.generation ||
          current.appGeneration !== binding.appGeneration
        )
          return;
        yield* grant(current, current.appGeneration);
        const files = yield* decodeFiles(result.files);
        const commitSha = yield* decodeSha(result.commitSha);
        if (binding.commitSha && binding.commitSha !== commitSha)
          return yield* new DefinitionSourceError({ reason: "invalid_definition" });
        const parsed = validateFactoryFiles(files);
        const issues = Result.isFailure(parsed)
          ? parsed.failure
          : parsed.success.factoryId !== binding.factoryId
            ? [
                {
                  file: "factory.yaml",
                  path: ["factoryId"],
                  message: "Factory ID does not match source binding.",
                },
              ]
            : [];
        const valid = issues.length === 0;
        const contentHash = Result.isSuccess(parsed)
          ? yield* hash(canonicalFactoryJson(parsed.success))
          : null;
        const id = `git-revision:${yield* hash(`${binding.factoryId}:${binding.repositoryId}:${binding.repository}:${binding.branch}:${binding.path}:${binding.commitSha ?? ""}:${commitSha}`)}`;
        yield* sql`INSERT INTO foundry_automation.definition_git_revisions(id,factory_id,commit_sha,content_hash,valid,issues,files,created_at,location) VALUES(${id},${binding.factoryId},${commitSha},${contentHash},${valid},${sql.json(issues)},${sql.json(files)},${now},${sql.json({ connectionId: binding.connectionId, repositoryId: binding.repositoryId, repository: binding.repository, branch: binding.branch, path: binding.path, ...(binding.commitSha ? { commitSha: binding.commitSha } : {}) })}) ON CONFLICT DO NOTHING`;
        const stored = yield* sql<{
          valid: boolean;
        }>`SELECT valid FROM foundry_automation.definition_git_revisions WHERE id=${id}`;
        yield* sql`UPDATE foundry_automation.definition_sources SET selected_revision_id=${id},status=${stored[0]?.valid ? "ready" : "invalid"},error=NULL,next_sync_at=${now + 60_000} WHERE factory_id=${binding.factoryId}`;
      }),
    );
  }, Effect.mapError(operationError));
  const fail = Effect.fn("DefinitionSources.fail")(function* (
    binding: Binding,
    reason: string,
    nextSyncAt: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(binding.factoryId);
        const current = yield* requireSource(binding.factoryId);
        if (
          !current.enabled ||
          current.generation !== binding.generation ||
          current.appGeneration !== binding.appGeneration
        )
          return;
        yield* sql`UPDATE foundry_automation.definition_sources SET status='error',error=${reason.slice(0, 200)},next_sync_at=${nextSyncAt} WHERE factory_id=${binding.factoryId}`;
      }),
    );
  }, Effect.mapError(operationError));
  const listRevisions = Effect.fn("DefinitionSources.listRevisions")(function* (
    factoryId: string,
    after: string | undefined,
    limit: number,
  ) {
    const size = Math.max(1, Math.min(100, limit));
    const rows =
      yield* sql<FactoryDefinitionGitRevision>`SELECT id,factory_id AS "factoryId",commit_sha AS "commitSha",content_hash AS "contentHash",valid,issues,created_at::float8 AS "createdAt",location FROM foundry_automation.definition_git_revisions WHERE factory_id=${factoryId} AND (${after ?? null}::text IS NULL OR id>${after ?? null}) ORDER BY id LIMIT ${size + 1}`;
    const items = rows.slice(0, size);
    return { items, next: rows.length > size ? items.at(-1)!.id : null };
  }, Effect.mapError(operationError));
  return DefinitionSources.of({
    configure,
    requestSync,
    setEnabled,
    activateRevision,
    source,
    due,
    accept,
    fail,
    listRevisions,
    readRevision,
  });
});
export const layer = Layer.effect(DefinitionSources, make);
