// @effect-diagnostics globalFetch:off - These assertions read and revoke local blob URLs, not HTTP resources.
import { describe, expect, it } from "@effect/vitest";
import {
  ASSET_TRANSFER_CHUNK_BYTES,
  ASSET_TRANSFER_MAX_BYTES,
  type AttachmentChunkStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  assetDigest,
  materializeAsset,
  readAssetChunks,
  writeAttachmentChunks,
} from "./assetTransfer.ts";

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("gateway asset transfer", () => {
  it.effect(
    "verifies every chunk and refuses corruption, changed revisions, gaps and oversize",
    () =>
      Effect.gen(function* () {
        const bytes = new Uint8Array(ASSET_TRANSFER_CHUNK_BYTES + 7).fill(61);
        const revision = yield* Effect.promise(() => assetDigest(bytes));
        for (const fault of [
          "none",
          "hash",
          "revision",
          "offset",
          "size",
          "empty",
          "base64",
        ] as const) {
          const result = yield* readAssetChunks("/api/assets/token/a.txt", (input) =>
            Effect.tryPromise(async () => {
              const part = bytes.slice(input.offset, input.offset + ASSET_TRANSFER_CHUNK_BYTES);
              if (input.offset > 0) expect(input.revision).toBe(revision);
              return {
                offset: input.offset + (fault === "offset" ? 1 : 0),
                total: fault === "size" ? ASSET_TRANSFER_MAX_BYTES + 1 : bytes.length,
                revision: fault === "revision" && input.offset > 0 ? "0".repeat(64) : revision,
                sha256: fault === "hash" ? "0".repeat(64) : await assetDigest(part),
                data: fault === "empty" ? "" : fault === "base64" ? "???" : encode(part),
              };
            }),
          ).pipe(Effect.result);
          if (fault === "none") expect(result).toMatchObject({ _tag: "Success", success: bytes });
          else
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "AssetTransferError" },
            });
        }
      }),
  );

  it("resumes at confirmed bytes after a lost reply and publishes only the matching file", async () => {
    const bytes = new Uint8Array(ASSET_TRANSFER_CHUNK_BYTES * 2 + 5).fill(42);
    const file = new Blob([bytes]);
    let status: AttachmentChunkStatus = { offset: 0, complete: false, fileSha256: null };
    const stored = new Uint8Array(bytes.length);
    const offsets: number[] = [];
    let loseReply = true;
    const transfer = () =>
      writeAttachmentChunks({
        file,
        url: "/api/attachments/upload/token",
        signal: new AbortController().signal,
        onProgress: () => {},
        status: async () => status,
        write: async (chunk) => {
          offsets.push(chunk.offset);
          const part = Uint8Array.from(Buffer.from(chunk.data, "base64"));
          expect(await assetDigest(part)).toBe(chunk.sha256);
          stored.set(part, chunk.offset);
          status = {
            offset: chunk.offset + part.length,
            complete: chunk.offset + part.length === bytes.length,
            fileSha256: chunk.fileSha256,
          };
          if (loseReply) {
            loseReply = false;
            throw new Error("reply lost");
          }
          return status;
        },
      });
    await expect(transfer()).rejects.toThrow("reply lost");
    await transfer();
    expect(offsets).toEqual([0, ASSET_TRANSFER_CHUNK_BYTES, ASSET_TRANSFER_CHUNK_BYTES * 2]);
    expect(await assetDigest(stored)).toBe(await assetDigest(bytes));
    await transfer();
    expect(offsets).toHaveLength(3);
    status = { offset: 1, complete: false, fileSha256: "0".repeat(64) };
    await expect(transfer()).rejects.toThrow("changed");
    expect(offsets).toHaveLength(3);
  });

  it("stops after cancellation and can finish publication after a lost final acknowledgement", async () => {
    const bytes = new Uint8Array(ASSET_TRANSFER_CHUNK_BYTES + 3).fill(7);
    const controller = new AbortController();
    let calls = 0;
    await expect(
      writeAttachmentChunks({
        file: new Blob([bytes]),
        url: "/api/attachments/upload/token",
        signal: controller.signal,
        status: async () => ({ offset: 0, complete: false, fileSha256: null }),
        onProgress: () => {},
        write: async (chunk) => {
          calls++;
          controller.abort();
          return {
            offset: ASSET_TRANSFER_CHUNK_BYTES,
            complete: false,
            fileSha256: chunk.fileSha256,
          };
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    await writeAttachmentChunks({
      file: new Blob([bytes]),
      url: "/api/attachments/upload/token",
      signal: new AbortController().signal,
      status: async () => ({
        offset: bytes.length,
        complete: false,
        fileSha256: await assetDigest(bytes),
      }),
      onProgress: () => {},
      write: async (chunk) => {
        expect(chunk.offset).toBe(ASSET_TRANSFER_CHUNK_BYTES);
        expect(chunk.data).toBe(encode(bytes.slice(ASSET_TRANSFER_CHUNK_BYTES)));
        return { offset: bytes.length, complete: true, fileSha256: chunk.fileSha256 };
      },
    });
  });

  it("keeps HTML passive and SVG opaque, and revokes only the owned blob", async () => {
    const bytes = new TextEncoder().encode(
      '<script>navigator.serviceWorker.register("/sw.js")</script>',
    );
    const html = materializeAsset(bytes, "/api/assets/token/page.html");
    const svg = materializeAsset(bytes, "/api/assets/token/icon.svg");
    expect(html.url.startsWith("data:text/plain;base64,")).toBe(true);
    expect(new URL(html.url).origin).toBe("null");
    expect(new URL(svg.url).origin).toBe("null");
    const first = materializeAsset(bytes, "/api/assets/token/text.txt");
    const second = materializeAsset(bytes, "/api/assets/other/text.txt");
    try {
      expect((await fetch(first.url)).headers.get("content-type")).toBe("application/octet-stream");
      first.dispose();
      await expect(fetch(first.url)).rejects.toThrow();
      expect(await (await fetch(second.url)).text()).toContain("<script>");
    } finally {
      first.dispose();
      second.dispose();
      html.dispose();
      svg.dispose();
    }
  });
});
