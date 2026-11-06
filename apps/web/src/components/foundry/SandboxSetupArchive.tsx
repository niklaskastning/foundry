import type { FoundryArtifactManifest } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { sandboxSetupArchiveCommand } from "../../foundry/sandboxArchive";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

type Props = { manifest: FoundryArtifactManifest; onClose: () => void };
export function SandboxSetupArchive(props: Props) {
  return (
    <SetupArchiveContent
      key={`${props.manifest.reference.artifactId}:${props.manifest.sha256}`}
      {...props}
    />
  );
}
function SetupArchiveContent({ manifest, onClose }: Props) {
  const command = useAtomCommand(sandboxSetupArchiveCommand, { reportFailure: false });
  const [parts, setParts] = useState<ReadonlyArray<FoundryArtifactManifest>>();
  const [failed, setFailed] = useState(false);
  const [completedGeneration, setCompletedGeneration] = useState<number>();
  const [generation, setGeneration] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<FoundryArtifactManifest>();
  const read = useEffectEvent(() => command(manifest));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Download and verify the confirmed archive index when opened or explicitly retried.
  useEffect(() => {
    let disposed = false;

    void read().then((result) => {
      if (disposed) return;
      setFailed(!AsyncResult.isSuccess(result));
      if (AsyncResult.isSuccess(result)) setParts(result.value.parts);
      setCompletedGeneration(generation);
    });
    return () => {
      disposed = true;
    };
  }, [generation]);
  const start = page * 20;
  const loading = completedGeneration !== generation;
  return (
    <section className="space-y-3" aria-label="Setup archive files">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Setup archive</p>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close archive
        </Button>
      </div>
      {loading ? <p role="status">Loading verified archive index…</p> : null}
      {failed && !loading ? (
        <div className="space-y-2">
          <p role="alert">
            The archive could not be verified or downloaded. Check your Main connection.
          </p>
          <Button variant="outline" onClick={() => setGeneration((value) => value + 1)}>
            Retry archive
          </Button>
        </div>
      ) : null}
      {parts ? (
        <>
          <p className="text-sm text-muted-foreground">
            {parts.length} confirmed {parts.length === 1 ? "file" : "parts"}. Open each part to
            inspect or download its contents.
          </p>
          <ul className="space-y-2">
            {parts.slice(start, start + 20).map((part, index) => (
              <li
                key={`${part.reference.artifactId}:${start + index}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="min-w-0 break-all text-sm">
                  {start + index + 1}. {part.name} · {formatAttachmentSize(part.sizeBytes)}
                </span>
                <Button size="sm" variant="outline" onClick={() => setSelected(part)}>
                  Open part {start + index + 1}
                </Button>
              </li>
            ))}
          </ul>
          {parts.length > 20 ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous parts
              </Button>
              <span className="text-xs">
                {start + 1}–{Math.min(start + 20, parts.length)} of {parts.length}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={start + 20 >= parts.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next parts
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {selected ? (
        <div className="flex h-96 flex-col overflow-hidden rounded-lg border">
          <AttachmentFilePreview
            key={selected.reference.artifactId}
            name={selected.name}
            mimeType={selected.mimeType}
            sizeBytes={selected.sizeBytes}
            asset={{
              environmentId: selected.reference.owner.environmentId,
              attachmentId: selected.reference.artifactId,
              foundryArtifact: selected,
            }}
            onClose={() => setSelected(undefined)}
          />
        </div>
      ) : null}
    </section>
  );
}
