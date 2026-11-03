import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ARCHIVE_UNAVAILABLE_RESOURCE = "foundry-archive:unavailable";
const inlineResource = "foundry-archive:inline";
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const resourceKeys = new Set([
  "resourceUrl",
  "resourceURL",
  "resourceUri",
  "resourceURI",
  "imageUrl",
  "imageURL",
  "image_url",
  "imagePath",
  "assetUrl",
  "assetURL",
  "downloadUrl",
  "downloadURL",
  "gatewayTicket",
  "socketTicket",
]);
const resourceTypes = new Set([
  "image",
  "image_url",
  "resource",
  "resource_link",
  "file",
  "video",
  "audio",
]);

const resourceEnvelope = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(resourceEnvelope);
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (
    (typeof object.type === "string" && resourceTypes.has(object.type)) ||
    Object.keys(object).some(
      (key) => resourceKeys.has(key) || key === "htmlRender" || key === "t3McpApp",
    ) ||
    (Array.isArray(object.content) && object.content.some(resourceEnvelope))
  );
};

export function archiveToolResources(value: unknown, resource = false): unknown {
  if (typeof value === "string") {
    const parsed = decodeJson(value);
    return Option.isSome(parsed) && resourceEnvelope(parsed.value)
      ? encodeJson(archiveToolResources(parsed.value))
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => archiveToolResources(entry, resource));
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const isResource =
    resource || (typeof object.type === "string" && resourceTypes.has(object.type));
  const inline = ["data", "blob", "text"].some((key) => typeof object[key] === "string");
  const result = Object.fromEntries(
    Object.entries(object).map(([key, entry]) => {
      if (
        typeof entry === "string" &&
        (resourceKeys.has(key) ||
          (isResource && ["url", "uri", "path", "filePath", "file_path"].includes(key)) ||
          (["url", "uri"].includes(key) &&
            /^(?:blob:|file:)|\/api\/foundry\/gateway(?:\/|\?)/.test(entry)))
      ) {
        return [
          key,
          entry.startsWith("data:") ||
          entry === inlineResource ||
          entry === ARCHIVE_UNAVAILABLE_RESOURCE
            ? entry
            : inline && isResource
              ? inlineResource
              : ARCHIVE_UNAVAILABLE_RESOURCE,
        ];
      }
      if (
        (key === "htmlRender" || key === "t3McpApp") &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry)
      ) {
        return [
          key,
          {
            ...(archiveToolResources(entry) as Record<string, unknown>),
            attachmentId: ARCHIVE_UNAVAILABLE_RESOURCE,
          },
        ];
      }
      return [
        key,
        archiveToolResources(
          entry,
          key === "resource" || (isResource && ["source", "image_url"].includes(key)),
        ),
      ];
    }),
  );
  const source =
    object.source !== null && typeof object.source === "object"
      ? (object.source as Record<string, unknown>)
      : undefined;
  if (
    object.type === "image" &&
    typeof object.sizeBytes !== "number" &&
    ((typeof object.mimeType === "string" && !inline && source === undefined) ||
      (source?.type === "base64" && typeof source.data !== "string"))
  )
    result.archiveResource = ARCHIVE_UNAVAILABLE_RESOURCE;
  return result;
}
