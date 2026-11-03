import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryArtifactId,
  FoundryArtifactError,
  FoundryInstanceId,
  ThreadId,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import { artifactSha256, downloadArtifact, type ArtifactTransport } from "./foundryArtifacts.ts";

const bytes = new TextEncoder().encode("confirmed fixture");
const manifest: FoundryArtifactManifest = {
  reference: {
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
    owner: { environmentId: EnvironmentId.make("worker"), threadId: ThreadId.make("thread") },
  },
  name: "fixture.txt",
  mimeType: "text/plain",
  sizeBytes: bytes.byteLength,
  sha256: artifactSha256(bytes),
};

it.effect.each([
  "none",
  "whole-file",
  "chunk",
  "offset",
  "total",
  "truncated",
  "reference",
  "base64",
  "empty-missing",
] as const)("verifies downloaded bytes before returning them (%s)", (fault) =>
  Effect.gen(function* () {
    const changed = bytes.slice();
    changed[0] = changed[0]! ^ 1;
    const data = fault === "whole-file" ? changed : bytes;
    const transport: ArtifactTransport = Effect.fn("ArtifactsTest.transport")(function* (request) {
      if (fault === "empty-missing") {
        if (request.op === "metadata")
          return { ...manifest, sizeBytes: 0, sha256: artifactSha256(new Uint8Array()) };
        return yield* new FoundryArtifactError({ code: "unavailable" });
      }
      if (request.op === "metadata")
        return fault === "reference"
          ? {
              ...manifest,
              reference: {
                ...manifest.reference,
                owner: { ...manifest.reference.owner, threadId: ThreadId.make("foreign-thread") },
              },
            }
          : manifest;
      return {
        offset: fault === "offset" ? 1 : 0,
        total: fault === "total" ? data.byteLength + 1 : data.byteLength,
        fileSha256: manifest.sha256,
        sha256: fault === "chunk" ? "0".repeat(64) : artifactSha256(data),
        data:
          fault === "truncated"
            ? ""
            : fault === "base64"
              ? `${Base64.encode(data)} `
              : Base64.encode(data),
      };
    });
    const result = yield* downloadArtifact(transport, manifest.reference).pipe(Effect.result);
    if (fault === "none") {
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.bytes).toEqual(bytes);
    } else {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe(fault === "empty-missing" ? "unavailable" : "changed");
    }
  }),
);
