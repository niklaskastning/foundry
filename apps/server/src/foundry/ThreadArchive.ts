import {
  FOUNDRY_ARCHIVE_PAGE_BYTES,
  FoundryArchiveError,
  FoundryArchiveIngest,
  FoundryArchiveRead,
  FoundryArchiveList,
  FoundryArchiveOwner,
  FoundryArchiveEvent,
  FoundryArtifactReference,
  type FoundryArchiveStatus,
  type FoundryArchivePage,
  type FoundryArchiveListPage,
  type FoundryInstanceId,
  type FoundryDeviceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as ArtifactFiles from "./ArtifactFiles.ts";
import { archiveEvent } from "./archiveEvent.ts";

export interface FoundryArchivePrincipal {
  readonly instanceId: FoundryInstanceId;
  readonly operatorId: string;
  readonly deviceId?: FoundryDeviceId;
  readonly generation?: number;
  readonly deviceEnvironmentId?: EnvironmentId;
}
export class ThreadArchive extends Context.Service<
  ThreadArchive,
  {
    readonly ingest: (
      principal: FoundryArchivePrincipal,
      input: FoundryArchiveIngest,
    ) => Effect.Effect<FoundryArchiveStatus, FoundryArchiveError>;
    readonly cursor: (
      principal: FoundryArchivePrincipal,
      owner: FoundryArchiveOwner,
    ) => Effect.Effect<FoundryArchiveStatus, FoundryArchiveError>;
    readonly read: (
      principal: FoundryArchivePrincipal,
      input: FoundryArchiveRead,
    ) => Effect.Effect<FoundryArchivePage, FoundryArchiveError>;
    readonly list: (
      principal: FoundryArchivePrincipal,
      input: FoundryArchiveList,
    ) => Effect.Effect<FoundryArchiveListPage, FoundryArchiveError>;
  }
>()("t3/foundry/ThreadArchive") {}

const fail = (code: FoundryArchiveError["code"]) => new FoundryArchiveError({ code });
const isArchiveError = Schema.is(FoundryArchiveError);
const operationError = (error: unknown) =>
  isArchiveError(error)
    ? error
    : Schema.isSchemaError(error)
      ? fail("invalid_request")
      : fail("unavailable");
const decodeIngest = Schema.decodeEffect(Schema.toType(FoundryArchiveIngest), {
  onExcessProperty: "error",
});
const decodeOwner = Schema.decodeEffect(FoundryArchiveOwner, { onExcessProperty: "error" });
const decodeRead = Schema.decodeEffect(FoundryArchiveRead, { onExcessProperty: "error" });
const decodeList = Schema.decodeEffect(FoundryArchiveList, { onExcessProperty: "error" });
const encodeIngest = Schema.encodeEffect(FoundryArchiveIngest);
const jsonSize = (value: unknown) => new TextEncoder().encode(stableStringify(value)).byteLength;
const encodeEvent = Schema.encodeEffect(FoundryArchiveEvent);
const decodeEvent = Schema.decodeUnknownEffect(FoundryArchiveEvent);
const decodeReference = Schema.decodeUnknownEffect(FoundryArtifactReference);
type ThreadRow = {
  ordinal: string;
  environment_id: EnvironmentId;
  thread_id: FoundryArchiveOwner["threadId"];
  confirmed_cursor: number;
  confirmed_source_sequence: number;
  source_head: number;
  source_complete: boolean;
  device_id: FoundryDeviceId;
};
const attachmentClaims = (input: unknown): Map<string, unknown | null> => {
  const result = new Map<string, unknown | null>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (
      typeof object.id === "string" &&
      typeof object.mimeType === "string" &&
      typeof object.sizeBytes === "number"
    ) {
      const artifact = object.foundryArtifact;
      result.set(
        object.id,
        artifact && typeof artifact === "object" && "reference" in artifact
          ? artifact.reference
          : null,
      );
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(input);
  return result;
};
const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const files = yield* ArtifactFiles.ArtifactFiles;
  const columns = sql.literal(
    "ordinal::text,environment_id,thread_id,device_id,confirmed_cursor::float8,confirmed_source_sequence::float8,source_head::float8,source_complete",
  );
  const authorize = Effect.fn("ThreadArchive.authorize")(function* (
    principal: FoundryArchivePrincipal,
    owner?: FoundryArchiveOwner,
    write = false,
  ) {
    const operators =
      yield* sql`SELECT b.operator_id FROM foundry_instance.operator_binding b JOIN foundry_instance.instance i ON b.singleton=i.singleton WHERE i.instance_id=${principal.instanceId} AND b.operator_id=${principal.operatorId} FOR SHARE OF b,i`;
    if (!operators.length) return yield* fail("forbidden");
    if (principal.deviceId !== undefined || write) {
      if (
        !principal.deviceId ||
        !owner ||
        principal.deviceEnvironmentId !== owner.environmentId ||
        principal.generation === undefined
      )
        return yield* fail("forbidden");
      const devices =
        yield* sql`SELECT device_id FROM foundry_instance.devices WHERE device_id=${principal.deviceId} AND instance_id=${principal.instanceId} AND operator_id=${principal.operatorId} AND environment_id=${owner.environmentId} AND generation=${principal.generation} AND NOT revoked FOR SHARE`;
      if (!devices.length) return yield* fail("forbidden");
    }
  });
  const load = Effect.fn("ThreadArchive.load")(function* (
    principal: FoundryArchivePrincipal,
    owner: FoundryArchiveOwner,
    lock = false,
  ) {
    const rows =
      yield* sql<ThreadRow>`SELECT ${columns} FROM foundry_instance.archive_threads WHERE instance_id=${principal.instanceId} AND operator_id=${principal.operatorId} AND environment_id=${owner.environmentId} AND thread_id=${owner.threadId} ${lock ? sql.literal("FOR UPDATE") : sql.literal("")}`;
    if (rows[0] && principal.deviceId && rows[0].device_id !== principal.deviceId)
      return yield* fail("forbidden");
    return rows[0];
  });
  const status = Effect.fn("ThreadArchive.status")(function* (
    principal: FoundryArchivePrincipal,
    owner: FoundryArchiveOwner,
    row?: ThreadRow,
  ) {
    const claims = yield* sql<{
      reference: unknown | null;
    }>`SELECT reference FROM foundry_instance.archive_artifacts WHERE instance_id=${principal.instanceId} AND environment_id=${owner.environmentId} AND thread_id=${owner.threadId}`;
    const missingArtifacts: FoundryArtifactReference[] = [];
    let missingAttachmentCount = 0;
    for (const claim of claims) {
      if (claim.reference === null) {
        missingAttachmentCount++;
        continue;
      }
      const reference = yield* decodeReference(claim.reference);
      const uploads = yield* sql<{
        size: number;
      }>`SELECT (request->>'sizeBytes')::int AS size FROM foundry_instance.artifact_uploads WHERE artifact_id=${reference.artifactId} AND instance_id=${principal.instanceId} AND operator_id=${principal.operatorId} AND request->'owner'=${sql.json(owner)}::jsonb AND state='published'`;
      const upload = uploads[0];
      const present = upload
        ? yield* files
            .read(
              reference.artifactId,
              Math.max(0, upload.size - 1),
              Math.min(upload.size, 1),
              true,
            )
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
        : false;
      if (!present && !missingArtifacts.some((item) => item.artifactId === reference.artifactId))
        missingArtifacts.push(reference);
    }
    return {
      owner,
      confirmedCursor: row?.confirmed_cursor ?? 0,
      confirmedSourceSequence: row?.confirmed_source_sequence ?? 0,
      sourceHead: row?.source_head ?? 0,
      sourceComplete: row?.source_complete ?? false,
      complete:
        !!row &&
        row.source_complete &&
        row.confirmed_cursor > 0 &&
        row.confirmed_cursor === row.source_head &&
        missingArtifacts.length === 0 &&
        missingAttachmentCount === 0,
      missingArtifacts,
      missingAttachmentCount,
    };
  });
  const ingest = Effect.fn("ThreadArchive.ingest")(function* (
    principal: FoundryArchivePrincipal,
    raw: FoundryArchiveIngest,
  ) {
    const input = yield* decodeIngest(raw);
    if (jsonSize(yield* encodeIngest(input)) > FOUNDRY_ARCHIVE_PAGE_BYTES - 4096)
      return yield* fail("invalid_request");
    if (input.instanceId !== principal.instanceId) return yield* fail("forbidden");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(principal, input.owner, true);
        yield* sql`INSERT INTO foundry_instance.archive_threads(instance_id,operator_id,environment_id,thread_id,device_id,source_complete) VALUES(${input.instanceId},${principal.operatorId},${input.owner.environmentId},${input.owner.threadId},${principal.deviceId!},${input.sourceComplete}) ON CONFLICT DO NOTHING`;
        const row = yield* load(principal, input.owner, true);
        if (!row) return yield* fail("forbidden");
        if (row.source_complete !== input.sourceComplete) return yield* fail("conflict");
        let cursor = row.confirmed_cursor;
        let sourceSequence = row.confirmed_source_sequence;
        for (const item of input.events) {
          if (item.event.threadId !== input.owner.threadId || item.sequence > input.sourceHead)
            return yield* fail("invalid_request");
          const encoded = yield* encodeEvent({ ...item, event: archiveEvent(item.event) });
          if (item.sequence <= cursor) {
            const duplicate = yield* sql<{
              same: boolean;
            }>`SELECT event=${sql.json(encoded)}::jsonb AS same FROM foundry_instance.archive_events WHERE instance_id=${input.instanceId} AND environment_id=${input.owner.environmentId} AND thread_id=${input.owner.threadId} AND sequence=${item.sequence}`;
            if (!duplicate[0]?.same) return yield* fail("conflict");
            continue;
          }
          if (item.sequence !== cursor + 1) break;
          if (
            item.sourceSequence <= sourceSequence ||
            (cursor === 0 && input.sourceComplete && item.event.type !== "thread.created")
          )
            return yield* fail("conflict");
          const repeatedId =
            yield* sql`SELECT 1 FROM foundry_instance.archive_events WHERE instance_id=${input.instanceId} AND environment_id=${input.owner.environmentId} AND thread_id=${input.owner.threadId} AND event->'event'->>'id'=${item.event.id}`;
          if (repeatedId.length) return yield* fail("conflict");
          for (const [attachmentId, claim] of attachmentClaims(encoded)) {
            const reference = claim === null ? null : yield* decodeReference(claim);
            if (
              reference &&
              (reference.instanceId !== input.instanceId ||
                reference.owner.environmentId !== input.owner.environmentId ||
                reference.owner.threadId !== input.owner.threadId)
            )
              return yield* fail("forbidden");
            if (reference) {
              const prior = yield* sql<{
                same: boolean;
              }>`SELECT reference IS NULL OR reference=${sql.json(reference)}::jsonb AS same FROM foundry_instance.archive_artifacts WHERE instance_id=${input.instanceId} AND environment_id=${input.owner.environmentId} AND thread_id=${input.owner.threadId} AND attachment_id=${attachmentId}`;
              if (prior[0] && !prior[0].same) return yield* fail("conflict");
            }
            yield* sql`INSERT INTO foundry_instance.archive_artifacts(instance_id,environment_id,thread_id,attachment_id,reference) VALUES(${input.instanceId},${input.owner.environmentId},${input.owner.threadId},${attachmentId},${reference === null ? null : sql.json(reference)}) ON CONFLICT(instance_id,environment_id,thread_id,attachment_id) DO UPDATE SET reference=COALESCE(EXCLUDED.reference,foundry_instance.archive_artifacts.reference)`;
          }
          yield* sql`INSERT INTO foundry_instance.archive_events(instance_id,environment_id,thread_id,sequence,source_sequence,event) VALUES(${input.instanceId},${input.owner.environmentId},${input.owner.threadId},${item.sequence},${item.sourceSequence},${sql.json(encoded)})`;
          cursor = item.sequence;
          sourceSequence = item.sourceSequence;
        }
        const head = Math.max(input.sourceHead, row.source_head, cursor);
        yield* sql`UPDATE foundry_instance.archive_threads SET confirmed_cursor=${cursor},confirmed_source_sequence=${sourceSequence},source_head=${head} WHERE instance_id=${input.instanceId} AND environment_id=${input.owner.environmentId} AND thread_id=${input.owner.threadId}`;
        return yield* status(principal, input.owner, {
          ...row,
          confirmed_cursor: cursor,
          confirmed_source_sequence: sourceSequence,
          source_head: head,
        });
      }),
    );
  }, Effect.mapError(operationError));
  const cursor = Effect.fn("ThreadArchive.cursor")(function* (
    principal: FoundryArchivePrincipal,
    raw: FoundryArchiveOwner,
  ) {
    const owner = yield* decodeOwner(raw);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(principal, owner);
        return yield* status(principal, owner, yield* load(principal, owner));
      }),
    );
  }, Effect.mapError(operationError));
  const read = Effect.fn("ThreadArchive.read")(function* (
    principal: FoundryArchivePrincipal,
    raw: FoundryArchiveRead,
  ) {
    const input = yield* decodeRead(raw);
    if (principal.deviceId !== undefined) return yield* fail("forbidden");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
        yield* authorize(principal, input.owner);
        const row = yield* load(principal, input.owner);
        if (!row) return yield* fail("forbidden");
        const limit = input.limit ?? 50;
        const rows = yield* sql<{
          event: unknown;
        }>`SELECT event FROM foundry_instance.archive_events WHERE instance_id=${principal.instanceId} AND environment_id=${input.owner.environmentId} AND thread_id=${input.owner.threadId} AND sequence > ${input.after ?? 0} AND sequence <= ${row.confirmed_cursor} ORDER BY sequence LIMIT ${limit + 1}`;
        const selected: (typeof rows)[number][] = [];
        let bytes = 0;
        for (const entry of rows.slice(0, limit)) {
          const size = jsonSize(entry.event);
          if (bytes + size > FOUNDRY_ARCHIVE_PAGE_BYTES - 4096) break;
          selected.push(entry);
          bytes += size;
        }
        const events = yield* Effect.forEach(selected, (entry) => decodeEvent(entry.event));
        return {
          ...(yield* status(principal, input.owner, row)),
          events,
          nextCursor: rows.length > events.length ? events.at(-1)!.sequence : null,
        };
      }),
    );
  }, Effect.mapError(operationError));
  const list = Effect.fn("ThreadArchive.list")(function* (
    principal: FoundryArchivePrincipal,
    raw: FoundryArchiveList,
  ) {
    const input = yield* decodeList(raw);
    if (principal.deviceId !== undefined) return yield* fail("forbidden");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(principal);
        const rows =
          yield* sql<ThreadRow>`SELECT ${columns} FROM foundry_instance.archive_threads WHERE instance_id=${principal.instanceId} AND operator_id=${principal.operatorId} ${input.before ? sql`AND ordinal < ${input.before}::bigint` : sql.literal("")} ORDER BY ordinal DESC LIMIT 51`;
        const items = yield* Effect.forEach(rows.slice(0, 50), (row) =>
          status(principal, { environmentId: row.environment_id, threadId: row.thread_id }, row),
        );
        return { items, nextCursor: rows.length > 50 ? rows[49]!.ordinal : null };
      }),
    );
  }, Effect.mapError(operationError));
  return ThreadArchive.of({ ingest, cursor, read, list });
});
export const layer = Layer.effect(ThreadArchive, make);
