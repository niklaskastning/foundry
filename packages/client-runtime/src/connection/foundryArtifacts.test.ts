import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryInstanceId,
  FoundryArtifactId,
  ThreadId,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { FoundryInstanceSession, nativeHttpPolicy } from "./foundryMain.ts";
import * as FoundryArtifacts from "./foundryArtifacts.ts";

it.effect.each([
  "ok",
  "unsupported",
  "identity",
  "forbidden",
  "oversized",
  "loopback",
  "loopback-default",
  "native-production",
  "insecure-other",
] as const)("reads confirmed files from Main without a worker connection (%s)", (mode) =>
  Effect.gen(function* () {
    const binding = {
      origin:
        mode === "loopback" || mode === "loopback-default" || mode === "native-production"
          ? "http://localhost:17619"
          : mode === "insecure-other"
            ? "http://192.0.2.1:17619"
            : "https://main.example.test",
      issuer:
        mode === "native-production"
          ? "http://localhost:17619"
          : "https://team.cloudflareaccess.com",
      instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
      mainEnvironmentId: EnvironmentId.make("main"),
    };
    const bytes = new TextEncoder().encode("available after worker loss");
    const manifest: FoundryArtifactManifest = {
      reference: {
        instanceId: binding.instanceId,
        artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
        owner: {
          environmentId: EnvironmentId.make("offline-worker"),
          threadId: ThreadId.make("offline-thread"),
        },
      },
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: artifactSha256(bytes),
    };
    const calls: string[] = [];
    const client = yield* FoundryArtifacts.make(
      mode === "native-production" || mode === "insecure-other"
        ? nativeHttpPolicy
        : {
            allowLoopback: mode === "loopback" || mode === "insecure-other",
          },
    ).pipe(
      Effect.provide(
        Layer.merge(
          layerRemoteHttpClient((async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(binding.origin);
            expect(init?.credentials).toBe("include");
            expect(init?.redirect).toBe("manual");
            if (url.pathname === "/.well-known/foundry")
              return Response.json({
                protocolVersion: "1",
                instanceId:
                  mode === "identity" ? "33333333-3333-4333-8333-333333333333" : binding.instanceId,
                mainEnvironmentId: binding.mainEnvironmentId,
                capabilities: ["foundry.instance-descriptor", "foundry.access-sessions"],
                negotiatedCapabilities: [],
                ...(mode === "unsupported"
                  ? {}
                  : {
                      artifactTransfer: {
                        protocolVersion: "1",
                        chunkBytes: 256 * 1024,
                        maxBytes: 50 * 1024 * 1024,
                      },
                    }),
                instanceAuth: {
                  publicOrigin: binding.origin,
                  issuer: binding.issuer,
                  bootstrapMethods:
                    mode === "native-production" ? ["password"] : ["cloudflare-access-jwt"],
                  sessionMethods: ["foundry-session-cookie"],
                },
                auth: {
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["browser-session-cookie"],
                },
              });
            expect(url.pathname).toBe("/api/foundry/artifacts");
            expect(new Headers(init?.headers).get("x-foundry-csrf")).toBe("fixture-csrf");
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer fixture-main-token",
            );
            const request = (await new Response(init?.body).json()) as { op: string };
            calls.push(request.op);
            if (mode === "forbidden") return Response.json({ code: "forbidden" }, { status: 403 });
            if (mode === "oversized")
              return new Response(`"${"x".repeat(513 * 1024)}"`, {
                headers: { "content-type": "application/json" },
              });
            return Response.json(
              request.op === "list"
                ? { items: [manifest], nextCursor: null }
                : request.op === "metadata"
                  ? manifest
                  : {
                      offset: 0,
                      total: bytes.byteLength,
                      fileSha256: manifest.sha256,
                      sha256: manifest.sha256,
                      data: Base64.encode(bytes),
                    },
            );
          }) satisfies typeof fetch),
          Layer.succeed(FoundryInstanceSession, {
            current: () =>
              Effect.succeed({
                binding,
                csrfToken: "fixture-csrf",
                authorization: { _tag: "Bearer", token: "fixture-main-token" },
              }),
          }),
        ),
      ),
    );
    const result = yield* client.download(binding, manifest).pipe(Effect.result);
    if (mode === "ok" || mode === "loopback" || mode === "native-production") {
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.bytes).toEqual(bytes);
      expect((yield* client.list(binding, {})).items).toEqual([manifest]);
    } else expect(result._tag).toBe("Failure");
    if (
      mode === "identity" ||
      mode === "unsupported" ||
      mode === "loopback-default" ||
      mode === "insecure-other"
    )
      expect(calls).toEqual([]);
  }),
);
