import { FoundryUI } from "./FoundryUI";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import type { FoundryArtifactManifest } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { Button } from "../components/ui/button";
import { AttachmentFilePreview } from "../components/files/AttachmentFilePreview";
import { useAtomCommand } from "../state/use-atom-command";
import { artifactListCommand } from "./artifacts";

export function ArtifactLibrary() {
  const run = useAtomCommand(artifactListCommand, { reportFailure: false });
  const [items, setItems] = useState<ReadonlyArray<FoundryArtifactManifest>>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<FoundryArtifactManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load(before?: string) {
    setBusy(true);
    const result = await run(before ? { before } : {});
    if (AsyncResult.isSuccess(result)) {
      setItems(before ? [...items, ...result.value.items] : result.value.items);
      setNext(result.value.nextCursor);
      setMessage(result.value.items.length === 0 ? "No confirmed files found." : "");
    } else setMessage("Files could not be loaded. Verify your instance connection and try again.");
    setBusy(false);
  }
  return (
    <FoundryUI.Panel aria-label="Foundry files">
      <div className="flex items-center justify-between gap-3">
        <FoundryUI.Heading>Files</FoundryUI.Heading>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Load files
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Confirmed files are available here even when their original device is offline.
      </p>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.reference.artifactId} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatAttachmentSize(item.sizeBytes)}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setSelected(item)}
                aria-label={`Open ${item.name}`}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(next)}>
          More files
        </Button>
      ) : null}
      {busy || message ? (
        <p role="status" className="text-sm">
          {busy ? "Loading files…" : message}
        </p>
      ) : null}
      {selected ? (
        <div
          className="flex h-96 flex-col overflow-hidden rounded-lg border"
          key={selected.reference.artifactId}
        >
          <AttachmentFilePreview
            name={selected.name}
            mimeType={selected.mimeType}
            sizeBytes={selected.sizeBytes}
            asset={{
              environmentId: selected.reference.owner.environmentId,
              attachmentId: selected.reference.artifactId,
              foundryArtifact: selected,
            }}
            onClose={() => setSelected(null)}
          />
        </div>
      ) : null}
    </FoundryUI.Panel>
  );
}
