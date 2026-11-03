import { useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { AsyncResult, Atom } from "effect/reactivity";
import { FoundryArchive } from "@t3tools/client-runtime/connection";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import { applyCommandOutputFrame } from "@t3tools/client-runtime/state/command-output";
import { EMPTY_TERMINAL_OUTPUT } from "@t3tools/shared/terminalOutput";
import type {
  FoundryArchiveStatus,
  FoundryArchiveOwner,
  OrchestrationV2ThreadProjection,
  ChatFileAttachment,
} from "@t3tools/contracts";
import { Button } from "../components/ui/button";
import {
  ExpandedImageDialogHost,
  openExpandedImagePreview,
} from "../components/chat/ExpandedImageDialog";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import type { TurnItemSource } from "../components/chat/timelineRowContext";
import { AttachmentFilePreview } from "../components/files/AttachmentFilePreview";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useAtomCommand } from "../state/use-atom-command";
import { archiveListCommand, archiveReadCommand } from "./archives";

export function ThreadArchiveLibrary() {
  const list = useAtomCommand(archiveListCommand, { reportFailure: false });
  const read = useAtomCommand(archiveReadCommand, { reportFailure: false });
  const [items, setItems] = useState<ReadonlyArray<FoundryArchiveStatus>>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<FoundryArchiveOwner | null>(null);
  const [pageAfter, setPageAfter] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<FoundryArchiveStatus | null>(null);
  const [projection, setProjection] = useState<OrchestrationV2ThreadProjection | null>(null);
  const [file, setFile] = useState<ChatFileAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load(before?: string) {
    setBusy(true);
    const result = await list(before ? { before } : {});
    if (AsyncResult.isSuccess(result)) {
      setItems(before ? [...items, ...result.value.items] : result.value.items);
      setNext(result.value.nextCursor);
      setMessage(result.value.items.length ? "" : "No confirmed thread archives found.");
    } else setMessage("Thread archives could not be loaded. Verify your Main connection.");
    setBusy(false);
  }
  async function open(owner: FoundryArchiveOwner, after = 0) {
    setBusy(true);
    if (after === 0) {
      setProjection(null);
      setStatus(null);
      setPageAfter(null);
      setSelected(owner);
      setFile(null);
    }
    const result = await read({ owner, after });
    if (AsyncResult.isSuccess(result)) {
      try {
        const applied = FoundryArchive.applyArchivePage(
          after === 0 ? null : projection,
          after,
          result.value.events,
        );
        setProjection(applied.projection);
        setCursor(applied.cursor);
        setStatus(result.value);
        setPageAfter(result.value.nextCursor);
        setMessage("");
      } catch {
        setMessage("The archive contains a sequence gap; this history is incomplete.");
      }
    } else setMessage("This archive could not be read. Verify your current access and try again.");
    setBusy(false);
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Foundry thread archives">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">Thread archives</h2>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Load thread archives
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Confirmed history stays available from Main when its device is offline or removed.
        Continuing work requires an available writer and workspace.
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            className="flex items-center gap-3"
            key={`${item.owner.environmentId}:${item.owner.threadId}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              {item.owner.threadId} · confirmed {item.confirmedCursor}
              {item.complete ? "" : " · incomplete"}
            </span>
            <Button variant="outline" disabled={busy} onClick={() => void open(item.owner)}>
              Open thread archive
            </Button>
          </li>
        ))}
      </ul>
      {next ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(next)}>
          More thread archives
        </Button>
      ) : null}
      {message || busy ? (
        <p role="status" className="text-sm">
          {busy ? "Loading archive…" : message}
        </p>
      ) : null}
      {selected && status ? (
        <p role="status" className="text-sm">
          Confirmed through event {cursor} of {status.confirmedCursor}.{" "}
          {status.complete
            ? "Last reported source head confirmed; this is an archive, not a live connection."
            : `Incomplete archive: source head ${status.sourceHead}, missing files ${status.missingArtifacts.length + status.missingAttachmentCount}.`}
          {pageAfter !== null ? " More confirmed history is available." : ""}
        </p>
      ) : null}
      {projection ? (
        <ArchiveTimeline
          owner={selected!}
          projection={projection}
          onFileOpen={(attachment) => {
            if (!attachment.foundryArtifact) {
              setMessage(
                "This attachment has not been confirmed in Main and is unavailable offline.",
              );
              return;
            }
            setFile(attachment);
          }}
          onOpenThread={(threadId) => void open({ ...selected!, threadId })}
        />
      ) : null}
      {selected && pageAfter !== null ? (
        <Button variant="outline" disabled={busy} onClick={() => void open(selected, pageAfter)}>
          More confirmed history
        </Button>
      ) : null}
      {file?.foundryArtifact ? (
        <div className="flex h-96 flex-col overflow-hidden rounded-lg border">
          <AttachmentFilePreview
            name={file.name}
            mimeType={file.mimeType}
            sizeBytes={file.sizeBytes}
            asset={{
              environmentId: file.foundryArtifact.reference.owner.environmentId,
              attachmentId: file.id,
              foundryArtifact: file.foundryArtifact,
            }}
            onClose={() => setFile(null)}
          />
        </div>
      ) : null}
    </section>
  );
}

function ArchiveTimeline({
  owner,
  projection,
  onFileOpen,
  onOpenThread,
}: {
  owner: FoundryArchiveOwner;
  projection: OrchestrationV2ThreadProjection;
  onFileOpen: (file: ChatFileAttachment) => void;
  onOpenThread: (threadId: FoundryArchiveOwner["threadId"]) => void;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const theme = useRenderedAppearance();
  const source: TurnItemSource = {
    inlineDiff: true,
    readOnlyArchive: true,
    runtimeRequest: (requestId) =>
      projection.runtimeRequests.find((request) => request.id === requestId),
    detail: ({ itemId }) =>
      Atom.make(
        AsyncResult.success({
          item: projection.turnItems.find((item) => item.id === itemId) ?? null,
        }),
      ),
    commandOutput: ({ itemId }) => {
      const item = projection.turnItems.find((item) => item.id === itemId);
      return Atom.make(
        AsyncResult.success(
          applyCommandOutputFrame(
            { output: EMPTY_TERMINAL_OUTPUT, running: false },
            {
              kind: "replace",
              text: item?.type === "command_execution" ? (item.output ?? "") : "",
              running: false,
              truncated: false,
            },
          ),
        ),
      );
    },
  };
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: projection.visibleTurnItems,
    optimisticMessages: [],
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  }).map((entry) =>
    entry.kind === "message"
      ? { ...entry, message: { ...entry.message, streaming: false } }
      : entry,
  );
  const noop = () => {};
  return (
    <div
      className="flex h-[36rem] min-h-0 flex-col overflow-hidden rounded-lg border"
      aria-label="Confirmed thread history"
    >
      <MessagesTimeline
        renderHtmlRender={() => (
          <p className="text-sm">Archived HTML output is available as source in confirmed files.</p>
        )}
        renderMcpApp={() => (
          <p className="text-sm">Interactive app output is unavailable in an offline archive.</p>
        )}
        timelineEntries={entries}
        listRef={listRef}
        turnItemSource={source}
        canOperateThread={false}
        isWorking={false}
        latestRun={null}
        runs={projection.runs}
        turnDiffSummaries={deriveThreadCheckpointSummaries(projection)}
        routeThreadKey={`archive:${owner.environmentId}:${projection.thread.id}`}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={(preview) =>
          openExpandedImagePreview(
            `archive:${owner.environmentId}:${projection.thread.id}`,
            preview,
          )
        }
        onFileOpen={onFileOpen}
        onFileDownload={(attachment, preparedUrl) => {
          if (!attachment.foundryArtifact || !preparedUrl) {
            onFileOpen(attachment);
            return;
          }
          const link = document.createElement("a");
          link.href = preparedUrl;
          link.download = attachment.name;
          link.click();
        }}
        onOpenThread={onOpenThread}
        activeThreadEnvironmentId={owner.environmentId}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        resolvedTheme={theme}
        timestampFormat="24-hour"
        anchorMessageId={null}
        onAnchorReady={noop}
        onAnchorSizeChanged={noop}
        contentInsetEndAdjustment={0}
        onIsAtEndChange={noop}
        liveFollowEnabled={false}
        emptyPlaceholderInset={0}
        announceTurnStatus={false}
      />
      <ExpandedImageDialogHost
        threadKey={`archive:${owner.environmentId}:${projection.thread.id}`}
      />
    </div>
  );
}
