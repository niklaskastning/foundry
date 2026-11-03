import {
  FOUNDRY_ARTIFACT_CHUNK_BYTES,
  FoundryArtifactBegin,
  FoundryArtifactChunk,
  FoundryArtifactError,
  FoundryArtifactManifest,
  FoundryArtifactStatus,
  type FoundryArtifactReference,
  type FoundryArtifactRequest,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";

export type ArtifactTransport = (
  request: FoundryArtifactRequest,
) => Effect.Effect<unknown, FoundryArtifactError>;
export const artifactSha256 = (bytes: Uint8Array) =>
  Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const decodeBegin = Schema.decodeEffect(FoundryArtifactBegin);
const decodeStatus = Schema.decodeUnknownEffect(FoundryArtifactStatus);
const decodeManifest = Schema.decodeUnknownEffect(FoundryArtifactManifest);
const decodeChunk = Schema.decodeUnknownEffect(FoundryArtifactChunk);
const changed = () => new FoundryArtifactError({ code: "changed" });
const sameReference = (a: FoundryArtifactReference, b: FoundryArtifactReference) =>
  a.artifactId === b.artifactId &&
  a.instanceId === b.instanceId &&
  a.owner.environmentId === b.owner.environmentId &&
  a.owner.threadId === b.owner.threadId;
const request = Effect.fn("FoundryArtifacts.request")(
  (send: ArtifactTransport, input: FoundryArtifactRequest) =>
    send(input).pipe(Effect.retry({ times: 1, while: (error) => error.code === "unavailable" })),
);
export const publishArtifact = Effect.fn("FoundryArtifacts.publish")(function* (
  send: ArtifactTransport,
  raw: FoundryArtifactBegin,
  source: Uint8Array,
) {
  const input = yield* decodeBegin(raw).pipe(Effect.mapError(changed));
  if (source.byteLength !== input.sizeBytes) return yield* changed();
  const bytes = source.slice();
  if (artifactSha256(bytes) !== input.sha256) return yield* changed();
  let status = yield* request(send, { op: "begin", input }).pipe(
    Effect.flatMap(decodeStatus),
    Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
  );
  const reference = status.reference;
  if (
    reference.instanceId !== input.instanceId ||
    reference.owner.environmentId !== input.owner.environmentId ||
    reference.owner.threadId !== input.owner.threadId
  )
    return yield* changed();
  while (true) {
    if (
      !sameReference(reference, status.reference) ||
      status.state === "aborted" ||
      status.sha256 !== input.sha256 ||
      status.sizeBytes !== input.sizeBytes ||
      status.offset > input.sizeBytes ||
      (status.offset !== input.sizeBytes && status.offset % FOUNDRY_ARTIFACT_CHUNK_BYTES !== 0)
    )
      return yield* changed();
    if (status.offset === input.sizeBytes) break;
    const offset = status.offset;
    const chunk = bytes.subarray(offset, offset + FOUNDRY_ARTIFACT_CHUNK_BYTES);
    status = yield* request(send, {
      op: "write",
      input: { reference, offset, data: Base64.encode(chunk), sha256: artifactSha256(chunk) },
    }).pipe(
      Effect.flatMap(decodeStatus),
      Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
    );
    if (status.offset < offset + chunk.byteLength) return yield* changed();
  }
  const manifest = yield* request(send, { op: "publish", input: reference }).pipe(
    Effect.flatMap(decodeManifest),
    Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
  );
  if (
    !sameReference(reference, manifest.reference) ||
    manifest.sha256 !== input.sha256 ||
    manifest.sizeBytes !== input.sizeBytes ||
    manifest.name !== input.name ||
    manifest.mimeType !== input.mimeType
  )
    return yield* changed();
  return manifest;
});

export const downloadArtifact = Effect.fn("FoundryArtifacts.download")(function* (
  send: ArtifactTransport,
  reference: FoundryArtifactReference,
) {
  const manifest = yield* request(send, { op: "metadata", input: reference }).pipe(
    Effect.flatMap(decodeManifest),
    Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
  );
  if (!sameReference(reference, manifest.reference)) return yield* changed();
  const bytes = new Uint8Array(manifest.sizeBytes);
  let offset = 0;
  do {
    const chunk = yield* request(send, { op: "read", input: { reference, offset } }).pipe(
      Effect.flatMap(decodeChunk),
      Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
    );
    const decoded = Base64.decode(chunk.data);
    if (Result.isFailure(decoded)) return yield* changed();
    const data = decoded.success;
    if (
      chunk.offset !== offset ||
      chunk.total !== bytes.byteLength ||
      chunk.fileSha256 !== manifest.sha256 ||
      data.byteLength !== Math.min(FOUNDRY_ARTIFACT_CHUNK_BYTES, bytes.byteLength - offset) ||
      Base64.encode(data) !== chunk.data ||
      artifactSha256(data) !== chunk.sha256
    )
      return yield* changed();
    bytes.set(data, offset);
    offset += data.byteLength;
  } while (offset < bytes.byteLength);
  if (artifactSha256(bytes) !== manifest.sha256) return yield* changed();
  return { manifest, bytes };
});
