import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { archiveToolResources, ARCHIVE_UNAVAILABLE_RESOURCE } from "./archiveResources.ts";

const codec = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);

it("keeps inline resource bytes and transcript literals while neutralizing worker-only references", () => {
  const literal = "Read /srv/worker/file and quote blob:example as transcript";
  const output = {
    content: [
      { type: "text", text: literal },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "image", mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "file:///srv/worker/file", text: "inline resource text" },
      },
      { type: "resource_link", uri: "file:///srv/worker/missing" },
    ],
    resourceURL: "blob:ephemeral",
    htmlRender: { attachmentId: "local-html", title: "HTML", height: 320 },
    t3McpApp: { attachmentId: "local-app", resourceUri: "ui://local", server: "mcp", tool: "app" },
  };
  const result = archiveToolResources(output);
  expect(result).toMatchObject({
    content: [
      { type: "text", text: literal },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "image", archiveResource: ARCHIVE_UNAVAILABLE_RESOURCE },
      {
        type: "resource",
        resource: { uri: "foundry-archive:inline", text: "inline resource text" },
      },
      { type: "resource_link", uri: ARCHIVE_UNAVAILABLE_RESOURCE },
    ],
    resourceURL: ARCHIVE_UNAVAILABLE_RESOURCE,
    htmlRender: { attachmentId: ARCHIVE_UNAVAILABLE_RESOURCE },
    t3McpApp: {
      attachmentId: ARCHIVE_UNAVAILABLE_RESOURCE,
      resourceUri: ARCHIVE_UNAVAILABLE_RESOURCE,
    },
  });
  expect(archiveToolResources(result)).toEqual(result);
  expect(
    archiveToolResources({ type: "image_url", image_url: { url: "https://worker.example/asset" } }),
  ).toEqual({ type: "image_url", image_url: { url: ARCHIVE_UNAVAILABLE_RESOURCE } });
  expect(
    archiveToolResources({ type: "image", source: { type: "base64", media_type: "image/png" } }),
  ).toMatchObject({ archiveResource: ARCHIVE_UNAVAILABLE_RESOURCE });
  const encoded = archiveToolResources(
    encode({ content: [{ type: "resource_link", uri: "file:///srv/worker/missing" }] }),
  );
  expect(decode(encoded)).toEqual({
    content: [{ type: "resource_link", uri: ARCHIVE_UNAVAILABLE_RESOURCE }],
  });
  expect(
    archiveToolResources({
      resourceURL: "blob:temporary",
      text: "summary is not the resource body",
    }),
  ).toEqual({
    resourceURL: ARCHIVE_UNAVAILABLE_RESOURCE,
    text: "summary is not the resource body",
  });
  expect(archiveToolResources(literal)).toBe(literal);
  expect(archiveToolResources(encode({ text: literal }))).toBe(encode({ text: literal }));
});
