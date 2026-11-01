// @effect-diagnostics nodeBuiltinImport:off -- Independent digests verify bytes persisted by the real filesystem service.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ASSET_TRANSFER_CHUNK_BYTES, ASSET_TRANSFER_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as AssetTransfer from "./AssetTransfer.ts";
import { issueAttachmentUploadUrl } from "./AttachmentUpload.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DocumentText from "../provider/DocumentText.ts";

const dependencies = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  WorkspacePaths.layer,
  ServerSecretStore.layer,
  DocumentText.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "asset-transfer-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = AssetTransfer.layer.pipe(Layer.provideMerge(dependencies));
const hash = (data: Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const issue = (sizeBytes: number) =>
  issueAttachmentUploadUrl({
    type: "file",
    name: "fixture.bin",
    mimeType: "application/octet-stream",
    sizeBytes,
  });

it.effect(
  "resumes confirmed chunks after lost replies and publishes exactly the original bytes",
  () =>
    Effect.gen(function* () {
      const service = yield* AssetTransfer.AssetTransfer;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const data = Buffer.alloc(ASSET_TRANSFER_CHUNK_BYTES + 19, 0x31);
      data.set(Buffer.from("<script>throw 'never execute'</script>"));
      const upload = yield* issue(data.length);
      const write = (offset: number) => {
        const part = data.subarray(offset, offset + ASSET_TRANSFER_CHUNK_BYTES);
        return service.write({
          url: upload.relativeUrl,
          offset,
          data: part.toString("base64"),
          sha256: hash(part),
          fileSha256: hash(data),
        });
      };
      expect(yield* service.status({ url: upload.relativeUrl })).toEqual({
        offset: 0,
        complete: false,
        fileSha256: null,
      });
      const first = yield* Effect.all([write(0), write(0)], { concurrency: "unbounded" });
      expect(first.map((s) => s.offset)).toEqual([
        ASSET_TRANSFER_CHUNK_BYTES,
        ASSET_TRANSFER_CHUNK_BYTES,
      ]);
      expect(yield* fs.exists(`${config.attachmentsDir}/${upload.attachmentId}.bin`)).toBe(false);
      const confirmed = yield* service.status({ url: upload.relativeUrl });
      expect(yield* write(confirmed.offset)).toMatchObject({ offset: data.length, complete: true });
      expect(yield* write(confirmed.offset)).toMatchObject({ offset: data.length, complete: true });
      const stored = yield* fs.readFile(`${config.attachmentsDir}/${upload.attachmentId}.bin`);
      expect(hash(stored)).toBe(hash(data));
      const asset = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: upload.attachmentId },
      });
      const chunk = yield* service.read({ url: asset.relativeUrl, offset: 0 });
      const tail = yield* service.read({
        url: asset.relativeUrl,
        offset: ASSET_TRANSFER_CHUNK_BYTES,
        revision: chunk.revision,
      });
      expect(chunk.sha256).toBe(hash(Buffer.from(chunk.data, "base64")));
      expect(
        hash(Buffer.concat([Buffer.from(chunk.data, "base64"), Buffer.from(tail.data, "base64")])),
      ).toBe(hash(data));
      expect(chunk.total).toBe(data.length);
      yield* fs.writeFile(
        `${config.attachmentsDir}/${upload.attachmentId}.bin`,
        Buffer.from("changed"),
      );
      expect(
        yield* service
          .read({ url: asset.relativeUrl, offset: 0, revision: chunk.revision })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "changed" });
      yield* service.remove(upload.attachmentId);
      expect(yield* service.status({ url: upload.relativeUrl })).toMatchObject({
        offset: 0,
        complete: false,
      });
      expect(yield* fs.exists(`${config.attachmentsDir}/${upload.attachmentId}.bin`)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reads signed workspace files in bounded chunks and rejects a changed revision or oversized file",
  () =>
    Effect.gen(function* () {
      const service = yield* AssetTransfer.AssetTransfer;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "asset-transfer-workspace-" });
      const content = Buffer.alloc(ASSET_TRANSFER_CHUNK_BYTES + 17, 0x41);
      yield* fs.writeFile(`${root}/file.html`, content);
      const signed = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: root, path: "file.html" },
        workspaceRoot: root,
      });
      const first = yield* service.read({ url: signed.relativeUrl, offset: 0 });
      expect(
        (yield* service
          .read({ url: signed.relativeUrl, offset: ASSET_TRANSFER_CHUNK_BYTES })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const second = yield* service.read({
        url: signed.relativeUrl,
        offset: ASSET_TRANSFER_CHUNK_BYTES,
        revision: first.revision,
      });
      expect(
        hash(
          Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]),
        ),
      ).toBe(hash(content));
      yield* fs.writeFile(`${root}/file.html`, Buffer.alloc(ASSET_TRANSFER_MAX_BYTES + 1));
      expect(
        yield* service.read({ url: signed.relativeUrl, offset: 0 }).pipe(Effect.flip),
      ).toMatchObject({ code: "capacity" });
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects forged targets, corrupt or out-of-order chunks and expired uploads", () =>
  Effect.gen(function* () {
    const service = yield* AssetTransfer.AssetTransfer;
    const bytes = Buffer.from("content");
    const upload = yield* issue(bytes.length);
    const input = {
      url: upload.relativeUrl,
      offset: 0,
      data: bytes.toString("base64"),
      sha256: hash(bytes),
      fileSha256: hash(bytes),
    };
    for (const changes of [
      { offset: 1 },
      { data: input.data + "!" },
      { sha256: "0".repeat(64) },
      { url: "https://foreign.test" + input.url },
      { url: "/api/attachments/upload/invalid.signature" },
    ]) {
      expect((yield* service.write({ ...input, ...changes }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }
    expect(yield* service.status({ url: input.url })).toMatchObject({ offset: 0 });
    expect(
      (yield* service.write({ ...input, fileSha256: "0".repeat(64) }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* service.status({ url: input.url })).toMatchObject({ complete: false });
    yield* service.remove(upload.attachmentId);
    yield* service.write(input);
    for (const url of [
      "https://foreign.test/api/assets/a/b",
      "/api/assets/a/../secret",
      "/api/assets/a/%2e%2e/secret",
      "/api/assets/invalid.signature/file",
    ]) {
      expect((yield* service.read({ url, offset: 0 }).pipe(Effect.result))._tag).toBe("Failure");
    }
    yield* TestClock.adjust("11 minutes");
    expect(yield* service.status({ url: input.url }).pipe(Effect.flip)).toMatchObject({
      code: "forbidden",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds chunk size, file size and aggregate reserved storage", () =>
  Effect.gen(function* () {
    const service = yield* AssetTransfer.AssetTransfer;
    const part = Buffer.alloc(ASSET_TRANSFER_CHUNK_BYTES, 1);
    for (let i = 0; i < 5; i++) {
      const upload = yield* issue(ASSET_TRANSFER_MAX_BYTES);
      const result = yield* service
        .write({
          url: upload.relativeUrl,
          offset: 0,
          data: part.toString("base64"),
          sha256: hash(part),
          fileSha256: hash(part),
        })
        .pipe(Effect.result);
      expect(result._tag).toBe(i === 4 ? "Failure" : "Success");
    }
    const oversizedChunk = Buffer.alloc(ASSET_TRANSFER_CHUNK_BYTES + 1);
    const invalid = yield* issue(oversizedChunk.length);
    expect(
      yield* service
        .write({
          url: invalid.relativeUrl,
          offset: 0,
          data: oversizedChunk.toString("base64"),
          sha256: hash(oversizedChunk),
          fileSha256: hash(oversizedChunk),
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "invalid_request" });
    const tooLarge = yield* issue(ASSET_TRANSFER_MAX_BYTES + 1);
    expect(yield* service.status({ url: tooLarge.relativeUrl }).pipe(Effect.flip)).toMatchObject({
      code: "capacity",
    });
  }).pipe(Effect.provide(layer)),
);
