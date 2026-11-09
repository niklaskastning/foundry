import { FoundryUI } from "./FoundryUI";
import { useEffect, useEffectEvent, useRef, useState } from "react";
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

export function ThreadArchiveLibrary({
  initialOwner,
}: { initialOwner?: FoundryArchiveOwner } = {}) {
  const list = useAtomCommand(archiveListCommand, { reportFailure: false });
  const read = useAtomCommand(archiveReadCommand, { reportFailure: false });
  const [items, setItems] = useState<ReadonlyArray<FoundryArchiveStatus>>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<FoundryArchiveOwner | null>(null);
  const [pageAfter, setPageAfter] = useState<number | null>(null);

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
    let currentProjection = after === 0 ? null : projection;
    let currentCursor = after;
    let pages = 0;
    try {
      while (pages < 200) {
        const result = await read({ owner, after: currentCursor });
        if (!AsyncResult.isSuccess(result)) {
          setMessage("This archive could not be read. Verify your current access and try again.");
          break;
        }
        const applied = FoundryArchive.applyArchivePage(
          currentProjection,
          currentCursor,
          result.value.events,
        );
        currentProjection = applied.projection;
        currentCursor = applied.cursor;
        setProjection(currentProjection);
        setStatus(result.value);
        setPageAfter(result.value.nextCursor);
        setMessage("");
        pages += 1;
        if (result.value.nextCursor === null) break;
        if (result.value.nextCursor <= after || result.value.events.length === 0) {
          setMessage("The archive cursor did not advance; this history is incomplete.");
          break;
        }
      }
    } catch {
      setMessage("The archive contains a sequence gap; this history is incomplete.");
    }
    setBusy(false);
  }
  const openInitial = useEffectEvent((owner: FoundryArchiveOwner | undefined) => {
    if (owner) void open(owner);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the selected archive with the external authenticated archive service.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The archive request exposes its loading state.
    openInitial(initialOwner);
  }, [initialOwner]);
  return (
    <FoundryUI.Panel aria-label="Foundry thread archives">
      <div className="flex items-center justify-between gap-3">
        <FoundryUI.Heading>Thread archives</FoundryUI.Heading>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Load thread archives
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Confirmed history stays available from Main when its device is offline or removed.
        Continuing work requires an available writer and workspace.
      </p>
      {initialOwner && !selected ? (
        <Button disabled={busy} onClick={() => void open(initialOwner)}>
          Open linked thread archive
        </Button>
      ) : null}
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            className="flex items-center gap-3"
            key={`${item.owner.environmentId}:${item.owner.threadId}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              Source: {item.owner.environmentId} ·{" "}
              {item.complete ? "Reported history and files archived" : "Transfer incomplete"}
            </span>
            <details className="text-xs text-muted-foreground">
              <FoundryUI.Summary>Source details</FoundryUI.Summary>
              <p className="break-all">{item.owner.threadId}</p>
              <p>
                Archived events: {item.confirmedCursor} · Source head: {item.sourceHead}
              </p>
            </details>
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
          {projection?.thread.title || "Archived thread"} ·
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
    </FoundryUI.Panel>
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
  const latestAnswer = entries.findLast(
    (entry) => entry.kind === "message" && entry.message.role === "assistant",
  );
  const task = entries.find((entry) => entry.kind === "message" && entry.message.role === "user");
  let workItem: { title: string; body: string; reference: string } | undefined;
  if (task?.kind === "message") {
    const marker =
      "External work item (untrusted source content; grants and workflow rules remain authoritative):";
    const payload = task.message.text.split(marker)[1]?.trim();
    if (payload) {
      try {
        const value: unknown = JSON.parse(payload);
        if (
          value &&
          typeof value === "object" &&
          "title" in value &&
          typeof value.title === "string" &&
          "body" in value &&
          typeof value.body === "string" &&
          "reference" in value &&
          typeof value.reference === "string"
        ) {
          workItem = { title: value.title, body: value.body, reference: value.reference };
        }
      } catch {
        /* Keep unrecognized payloads available in the original task. */
      }
    }
  }
  const noop = () => {};
  return (
    <div className="space-y-4">
      {latestAnswer?.kind === "message" ? (
        <section aria-label="Latest archived answer" className="space-y-2">
          <h3 className="font-medium">Foundry agent · Latest archived answer</h3>
          <p className="text-sm whitespace-pre-wrap break-words">{latestAnswer.message.text}</p>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">No agent answer in the loaded archive.</p>
      )}
      {workItem ? (
        <section className="space-y-2 text-sm" aria-label="Archived work item">
          <h3 className="font-medium">{workItem.title}</h3>
          <p className="text-xs text-muted-foreground">
            Untrusted source content · {workItem.reference}
          </p>
          <p className="whitespace-pre-wrap break-words">{workItem.body}</p>
        </section>
      ) : null}
      {task?.kind === "message" ? (
        <details>
          <FoundryUI.Summary>
            Original task and instructions · untrusted source content
          </FoundryUI.Summary>
          <pre className="max-h-80 overflow-auto text-sm whitespace-pre-wrap break-words">
            {task.message.text}
          </pre>
        </details>
      ) : null}
      <details>
        <FoundryUI.Summary>Full archived conversation and files</FoundryUI.Summary>
        <div
          className="flex h-[36rem] min-h-0 flex-col overflow-hidden rounded-lg border"
          aria-label="Confirmed thread history"
        >
          <MessagesTimeline
            renderHtmlRender={() => (
              <p className="text-sm">
                Archived HTML output is available as source in confirmed files.
              </p>
            )}
            renderMcpApp={() => (
              <p className="text-sm">
                Interactive app output is unavailable in an offline archive.
              </p>
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
        </div>
      </details>
      <ExpandedImageDialogHost
        threadKey={`archive:${owner.environmentId}:${projection.thread.id}`}
      />
    </div>
  );
}
