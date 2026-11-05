import type { FactoryDefinitionFiles } from "@t3tools/contracts";

type PreviewFile = FactoryDefinitionFiles[number] & { readonly size?: number | undefined };

export function factoryDefinitionPreview(file: PreviewFile): PreviewFile {
  if (file.encoding === "base64" && file.content === "" && file.size !== undefined) return file;
  const bytes =
    file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(file.content);
  const metadata = { ...file, size: bytes.byteLength };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // UTF-8 alone also accepts binary control bytes, which must not reach the text diff.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      return { ...metadata, encoding: "base64", content: "" };
    }
    return { ...metadata, encoding: "utf8", content: text };
  } catch {
    return { ...metadata, encoding: "base64", content: "" };
  }
}
