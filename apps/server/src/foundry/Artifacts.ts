// @effect-diagnostics nodeBuiltinImport:off -- Chunk hashes and canonical base64 belong to the bounded binary-transfer boundary.
import * as NodeCrypto from "node:crypto";
import {
  type FoundryInstanceId,
  type EnvironmentId,
  type FoundryArtifactOwner,
  type FoundryArtifactManifest,
  type FoundryArtifactPage,
  type FoundryArtifactChunk,
  FoundryArtifactId,
  FoundryArtifactReference,
  FoundryArtifactBegin,
  FoundryArtifactWrite,
  FoundryArtifactRead,
  FoundryArtifactList,
  FoundryArtifactStatus,
  FoundryArtifactError,
  FOUNDRY_ARTIFACT_CHUNK_BYTES,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as InstanceDatabase from "./InstanceDatabase.ts";
import * as InstancePostgres from "./InstancePostgres.ts";
import * as ArtifactFiles from "./ArtifactFiles.ts";

export interface ArtifactPrincipal {
  readonly instanceId: FoundryInstanceId;
  readonly operatorId: string;
  readonly deviceEnvironmentId?: EnvironmentId;
}
export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly begin: (
      principal: ArtifactPrincipal,
      input: FoundryArtifactBegin,
    ) => Effect.Effect<FoundryArtifactStatus, FoundryArtifactError>;
    readonly status: (
      principal: ArtifactPrincipal,
      reference: FoundryArtifactReference,
    ) => Effect.Effect<FoundryArtifactStatus, FoundryArtifactError>;
    readonly write: (
      principal: ArtifactPrincipal,
      input: FoundryArtifactWrite,
    ) => Effect.Effect<FoundryArtifactStatus, FoundryArtifactError>;
    readonly publish: (
      principal: ArtifactPrincipal,
      reference: FoundryArtifactReference,
    ) => Effect.Effect<FoundryArtifactManifest, FoundryArtifactError>;
    readonly abort: (
      principal: ArtifactPrincipal,
      reference: FoundryArtifactReference,
    ) => Effect.Effect<void, FoundryArtifactError>;
    readonly metadata: (
      principal: ArtifactPrincipal,
      reference: FoundryArtifactReference,
    ) => Effect.Effect<FoundryArtifactManifest, FoundryArtifactError>;
    readonly read: (
      principal: ArtifactPrincipal,
      input: FoundryArtifactRead,
    ) => Effect.Effect<FoundryArtifactChunk, FoundryArtifactError>;
    readonly readVerified?: (
      principal: ArtifactPrincipal,
      reference: FoundryArtifactReference,
    ) => Effect.Effect<
      { readonly manifest: FoundryArtifactManifest; readonly bytes: Uint8Array },
      FoundryArtifactError
    >;
    readonly list: (
      principal: ArtifactPrincipal,
      input: FoundryArtifactList,
    ) => Effect.Effect<FoundryArtifactPage, FoundryArtifactError>;
  }
>()("t3/foundry/Artifacts") {}

const decodeBegin = Schema.decodeEffect(FoundryArtifactBegin, { onExcessProperty: "error" });
const decodeWrite = Schema.decodeEffect(FoundryArtifactWrite, { onExcessProperty: "error" });
const decodeReference = Schema.decodeEffect(FoundryArtifactReference, {
  onExcessProperty: "error",
});
const decodeRead = Schema.decodeEffect(FoundryArtifactRead, { onExcessProperty: "error" });
const decodeList = Schema.decodeEffect(FoundryArtifactList, { onExcessProperty: "error" });
const isArtifactError = Schema.is(FoundryArtifactError);
const fail = (code: FoundryArtifactError["code"]) => new FoundryArtifactError({ code });
const operationError = (error: unknown) =>
  isArtifactError(error)
    ? error
    : Schema.isSchemaError(error)
      ? fail("invalid_request")
      : fail("unavailable");
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
type Row = {
  id: FoundryArtifactId;
  ordinal: string;
  request: FoundryArtifactBegin;
  state: FoundryArtifactStatus["state"];
  offset: number;
};
const manifest = (row: Row): FoundryArtifactManifest => ({
  reference: { instanceId: row.request.instanceId, artifactId: row.id, owner: row.request.owner },
  name: row.request.name,
  mimeType: row.request.mimeType,
  sizeBytes: row.request.sizeBytes,
  sha256: row.request.sha256,
});
const statusFor = (row: Row): FoundryArtifactStatus => ({
  reference: manifest(row).reference,
  state: row.state,
  offset: row.offset,
  sizeBytes: row.request.sizeBytes,
  sha256: row.request.sha256,
});
const make = Effect.gen(function* () {
  const sql = yield* InstanceDatabase.InstanceDatabase;
  const identity = yield* InstancePostgres.InstancePostgres;
  const files = yield* ArtifactFiles.ArtifactFiles;
  const crypto = yield* Crypto.Crypto;
  const columns = sql.literal(
    'artifact_id AS id,ordinal::text AS ordinal,request,state,confirmed_offset AS "offset"',
  );
  const authorize = Effect.fn("Artifacts.authorize")(function* (
    principal: ArtifactPrincipal,
    instanceId: FoundryInstanceId,
    owner?: FoundryArtifactOwner,
  ) {
    if (
      instanceId !== principal.instanceId ||
      instanceId !== (yield* identity.readIdentity) ||
      (owner &&
        principal.deviceEnvironmentId !== undefined &&
        owner.environmentId !== principal.deviceEnvironmentId)
    )
      return yield* fail("forbidden");
    const operators =
      yield* sql`SELECT operator_id FROM foundry_instance.operator_binding WHERE operator_id=${principal.operatorId}`;
    if (!operators.length) return yield* fail("forbidden");
  });
  const load = Effect.fn("Artifacts.load")(function* (
    principal: ArtifactPrincipal,
    raw: FoundryArtifactReference,
    lock = false,
  ) {
    const reference = yield* decodeReference(raw);
    yield* authorize(principal, reference.instanceId, reference.owner);
    const rows =
      yield* sql<Row>`SELECT ${columns} FROM foundry_instance.artifact_uploads WHERE artifact_id=${reference.artifactId} AND instance_id=${reference.instanceId} AND operator_id=${principal.operatorId} ${lock ? sql.literal("FOR UPDATE") : sql.literal("")}`;
    const row = rows[0];
    if (
      !row ||
      row.request.owner.environmentId !== reference.owner.environmentId ||
      row.request.owner.threadId !== reference.owner.threadId
    )
      return yield* fail("forbidden");
    return row;
  });
  const begin = Effect.fn("Artifacts.begin")(function* (
    principal: ArtifactPrincipal,
    raw: FoundryArtifactBegin,
  ) {
    const input = yield* decodeBegin(raw);
    yield* authorize(principal, input.instanceId, input.owner);
    const id = FoundryArtifactId.make(
      yield* crypto.randomUUIDv4().pipe(Effect.mapError(operationError)),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT operator_id FROM foundry_instance.operator_binding WHERE operator_id=${principal.operatorId} FOR UPDATE`;
        const existing =
          yield* sql<Row>`SELECT ${columns} FROM foundry_instance.artifact_uploads WHERE instance_id=${input.instanceId} AND operator_id=${principal.operatorId} AND command_id=${input.commandId}`;
        if (existing[0]) {
          const same = yield* sql<{
            same: boolean;
          }>`SELECT request=${sql.json(input)}::jsonb AS same FROM foundry_instance.artifact_uploads WHERE artifact_id=${existing[0].id}`;
          if (!same[0]?.same) return yield* fail("command_conflict");
          return statusFor(existing[0]);
        }
        const capacity = yield* sql<{
          count: number;
          bytes: number;
        }>`SELECT count(*)::int AS count,COALESCE(sum((request->>'sizeBytes')::bigint),0)::float8 AS bytes FROM foundry_instance.artifact_uploads WHERE operator_id=${principal.operatorId} AND state='uploading'`;
        if (
          (capacity[0]?.count ?? 32) >= 32 ||
          (capacity[0]?.bytes ?? 0) + input.sizeBytes > 256 * 1024 * 1024
        )
          return yield* fail("capacity");
        const rows =
          yield* sql<Row>`INSERT INTO foundry_instance.artifact_uploads(artifact_id,instance_id,operator_id,command_id,request) VALUES(${id},${input.instanceId},${principal.operatorId},${input.commandId},${sql.json(input)}) RETURNING ${columns}`;
        return statusFor(rows[0]!);
      }),
    );
  }, Effect.mapError(operationError));
  const status = Effect.fn("Artifacts.status")(function* (
    principal: ArtifactPrincipal,
    reference: FoundryArtifactReference,
  ) {
    return statusFor(yield* load(principal, reference));
  }, Effect.mapError(operationError));
  const metadata = Effect.fn("Artifacts.metadata")(function* (
    principal: ArtifactPrincipal,
    reference: FoundryArtifactReference,
  ) {
    const row = yield* load(principal, reference);
    if (row.state !== "published") return yield* fail("incomplete");
    return manifest(row);
  }, Effect.mapError(operationError));
  const write = Effect.fn("Artifacts.write")(function* (
    principal: ArtifactPrincipal,
    raw: FoundryArtifactWrite,
  ) {
    const input = yield* decodeWrite(raw);
    const bytes = Buffer.from(input.data, "base64");
    if (
      !bytes.length ||
      bytes.length > FOUNDRY_ARTIFACT_CHUNK_BYTES ||
      bytes.toString("base64") !== input.data ||
      digest(bytes) !== input.sha256
    )
      return yield* fail("invalid_request");
    // Filesystem promises cannot cancel; retain the row lock through durable I/O and commit.
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* load(principal, input.reference, true);
          if (row.state === "aborted") return yield* fail("changed");
          if (
            input.offset % FOUNDRY_ARTIFACT_CHUNK_BYTES !== 0 ||
            input.offset >= row.request.sizeBytes ||
            bytes.length !==
              Math.min(FOUNDRY_ARTIFACT_CHUNK_BYTES, row.request.sizeBytes - input.offset) ||
            input.offset > row.offset
          )
            return yield* fail("changed");
          if (input.offset < row.offset) {
            const previous = yield* files.read(
              row.id,
              input.offset,
              bytes.length,
              row.state === "published",
            );
            if (digest(previous) !== input.sha256) return yield* fail("command_conflict");
            return statusFor(row);
          }
          if (row.state !== "uploading") return yield* fail("changed");
          yield* files.write(row.id, input.offset, bytes);
          const next = input.offset + bytes.length;
          yield* sql`UPDATE foundry_instance.artifact_uploads SET confirmed_offset=${next} WHERE artifact_id=${row.id}`;
          return statusFor({ ...row, offset: next });
        }),
      )
      .pipe(Effect.uninterruptible);
  }, Effect.mapError(operationError));
  const publish = Effect.fn("Artifacts.publish")(function* (
    principal: ArtifactPrincipal,
    reference: FoundryArtifactReference,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* load(principal, reference, true);
          if (row.state === "aborted") return yield* fail("changed");
          if (row.offset !== row.request.sizeBytes) return yield* fail("incomplete");
          yield* files.publish(row.id, row.request.sizeBytes, row.request.sha256);
          if (row.state !== "published")
            yield* sql`UPDATE foundry_instance.artifact_uploads SET state='published' WHERE artifact_id=${row.id}`;
          return manifest(row);
        }),
      )
      .pipe(Effect.uninterruptible);
  }, Effect.mapError(operationError));
  const abort = Effect.fn("Artifacts.abort")(function* (
    principal: ArtifactPrincipal,
    reference: FoundryArtifactReference,
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* load(principal, reference, true);
          if (row.state === "published") return yield* fail("forbidden");
          yield* files.abort(row.id);
          yield* sql`UPDATE foundry_instance.artifact_uploads SET state='aborted' WHERE artifact_id=${row.id}`;
        }),
      )
      .pipe(Effect.uninterruptible);
  }, Effect.mapError(operationError));
  const read = Effect.fn("Artifacts.read")(function* (
    principal: ArtifactPrincipal,
    raw: FoundryArtifactRead,
  ) {
    const input = yield* decodeRead(raw);
    const value = yield* metadata(principal, input.reference);
    if (input.offset > value.sizeBytes) return yield* fail("invalid_request");
    const bytes = yield* files.read(
      input.reference.artifactId,
      input.offset,
      Math.min(FOUNDRY_ARTIFACT_CHUNK_BYTES, value.sizeBytes - input.offset),
      true,
    );
    return {
      offset: input.offset,
      total: value.sizeBytes,
      fileSha256: value.sha256,
      sha256: digest(bytes),
      data: Buffer.from(bytes).toString("base64"),
    };
  }, Effect.mapError(operationError));
  const readVerified = Effect.fn("Artifacts.readVerified")(function* (
    principal: ArtifactPrincipal,
    reference: FoundryArtifactReference,
  ) {
    const value = yield* publish(principal, reference);
    const bytes = yield* files.read(reference.artifactId, 0, value.sizeBytes, true);
    if (bytes.byteLength !== value.sizeBytes || digest(bytes) !== value.sha256)
      return yield* fail("changed");
    return { manifest: value, bytes };
  }, Effect.mapError(operationError));
  const list = Effect.fn("Artifacts.list")(function* (
    principal: ArtifactPrincipal,
    raw: FoundryArtifactList,
  ) {
    const input = yield* decodeList(raw);
    if (principal.deviceEnvironmentId !== undefined) return yield* fail("forbidden");
    yield* authorize(principal, principal.instanceId);
    const rows =
      yield* sql<Row>`SELECT ${columns} FROM foundry_instance.artifact_uploads WHERE instance_id=${principal.instanceId} AND operator_id=${principal.operatorId} AND state='published'
        ${input.before ? sql`AND ordinal < ${input.before}::bigint` : sql.literal("")}
        ${input.owner ? sql`AND request->'owner'=${sql.json(input.owner)}::jsonb` : sql.literal("")}
        ORDER BY ordinal DESC LIMIT 51`;
    const items = rows.slice(0, 50);
    return {
      items: items.map(manifest),
      nextCursor: rows.length > 50 ? items.at(-1)!.ordinal : null,
    };
  }, Effect.mapError(operationError));
  return Artifacts.of({ begin, status, write, publish, abort, metadata, read, readVerified, list });
});
export const layer = Layer.effect(Artifacts, make);
