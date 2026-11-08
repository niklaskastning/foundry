import {
  FoundrySandboxBundleIndex,
  FoundrySandboxArchiveError,
  FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const decode = Schema.decodeEffect(Schema.fromJsonString(FoundrySandboxBundleIndex));
export const decodeSandboxBundleIndex = Effect.fn("SandboxBundle.decodeIndex")(function* (
  manifest: FoundryArtifactManifest,
  bytes: Uint8Array,
) {
  if (
    manifest.mimeType !== FOUNDRY_SANDBOX_BUNDLE_MIME_TYPE ||
    bytes.byteLength > 1024 * 1024 ||
    bytes.byteLength !== manifest.sizeBytes ||
    artifactSha256(bytes) !== manifest.sha256
  )
    return yield* new FoundrySandboxArchiveError({ code: "changed" });
  const index = yield* decode(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => new FoundrySandboxArchiveError({ code: "changed" })),
  );
  const seen = new Set<string>();
  let size = 0;
  for (const part of index.parts) {
    if (
      seen.has(part.reference.artifactId) ||
      part.reference.instanceId !== manifest.reference.instanceId ||
      part.reference.owner.environmentId !== manifest.reference.owner.environmentId ||
      part.reference.owner.threadId !== manifest.reference.owner.threadId
    )
      return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
    seen.add(part.reference.artifactId);
    size += part.sizeBytes;
  }
  if (size !== index.sizeBytes) return yield* new FoundrySandboxArchiveError({ code: "changed" });
  return index;
});
