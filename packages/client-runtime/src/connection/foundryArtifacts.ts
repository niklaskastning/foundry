import {
  FOUNDRY_ARTIFACT_CHUNK_BYTES,
  FOUNDRY_ARTIFACT_MAX_BYTES,
  FoundryArtifactError,
  FoundryArtifactPage,
  type FoundryArtifactList,
  type FoundryArtifactManifest,
  type FoundryArtifactRequest,
} from "@t3tools/contracts";
import { downloadArtifact, type ArtifactTransport } from "@t3tools/shared/foundryArtifacts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { verifyDescriptor, type InstanceBinding } from "./foundry.ts";
import * as FoundryMain from "./foundryMain.ts";

const decodePage = Schema.decodeUnknownEffect(FoundryArtifactPage);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundryArtifactError.fields.code }),
);
const isArtifactError = Schema.is(FoundryArtifactError);
const failure = (error: unknown) =>
  isArtifactError(error)
    ? error
    : new FoundryArtifactError({
        code:
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "ConnectionBlockedError"
            ? "forbidden"
            : Schema.isSchemaError(error)
              ? "changed"
              : "unavailable",
      });
export const make = Effect.fn("FoundryArtifactsClient.make")(function* (
  options = { allowLoopback: false },
) {
  const main = yield* FoundryMain.make(options);
  const prepare = Effect.fn("FoundryArtifactsClient.prepare")(function* (binding: InstanceBinding) {
    const connection = yield* main.prepare(binding);
    const descriptor = yield* connection.request("/.well-known/foundry?protocolVersion=1").pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => verifyDescriptor(value, connection.origin, binding),
          catch: () => new FoundryArtifactError({ code: "changed" }),
        }),
      ),
    );
    if (
      descriptor.descriptor.artifactTransfer?.protocolVersion !== "1" ||
      descriptor.descriptor.artifactTransfer.chunkBytes !== FOUNDRY_ARTIFACT_CHUNK_BYTES ||
      descriptor.descriptor.artifactTransfer.maxBytes !== FOUNDRY_ARTIFACT_MAX_BYTES
    )
      return yield* new FoundryArtifactError({ code: "unavailable" });
    const send: ArtifactTransport = Effect.fn("FoundryArtifactsClient.request")(function* (
      input: FoundryArtifactRequest,
    ) {
      const result = yield* connection.response("/api/foundry/artifacts", input, true);
      if (result.status !== 200) {
        const value = yield* decodeFailure(result.value);
        return yield* new FoundryArtifactError({ code: value.code });
      }
      return result.value;
    }, Effect.mapError(failure));
    return send;
  }, Effect.mapError(failure));
  return {
    list: Effect.fn("FoundryArtifactsClient.list")(function* (
      binding: InstanceBinding,
      input: FoundryArtifactList,
    ) {
      const send = yield* prepare(binding);
      const page = yield* send({ op: "list", input }).pipe(Effect.flatMap(decodePage));
      if (page.items.some((item) => item.reference.instanceId !== binding.instanceId))
        return yield* new FoundryArtifactError({ code: "changed" });
      return page;
    }, Effect.mapError(failure)),
    download: Effect.fn("FoundryArtifactsClient.download")(function* (
      binding: InstanceBinding,
      expected: FoundryArtifactManifest,
    ) {
      if (expected.reference.instanceId !== binding.instanceId)
        return yield* new FoundryArtifactError({ code: "forbidden" });
      const send = yield* prepare(binding);
      const result = yield* downloadArtifact(send, expected.reference);
      if (
        result.manifest.sha256 !== expected.sha256 ||
        result.manifest.name !== expected.name ||
        result.manifest.mimeType !== expected.mimeType ||
        result.manifest.sizeBytes !== expected.sizeBytes
      )
        return yield* new FoundryArtifactError({ code: "changed" });
      return result;
    }, Effect.mapError(failure)),
  };
});
