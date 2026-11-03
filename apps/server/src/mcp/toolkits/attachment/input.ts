import { ChatFileAttachment, ChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Screenshot provenance and server-confirmed artifact manifests belong to app metadata, not tool inputs.
export const McpAttachmentInput = Schema.Union([
  ChatImageAttachment.mapFields(Struct.omit(["source", "foundryArtifact"])),
  ChatFileAttachment.mapFields(Struct.omit(["foundryArtifact"])),
]);
