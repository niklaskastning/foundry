import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { FoundrySandboxArchiveManifest } from "@t3tools/contracts";
import { FoundryUI } from "../../foundry/FoundryUI";
import { SandboxSetupArchive } from "./SandboxSetupArchive";
import type { FoundrySandboxDetail, FoundrySandboxMutation, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { ThreadArchiveLibrary } from "../../foundry/ThreadArchiveLibrary";

export function SandboxAllocationDetail({
  detail,
  busy,
  canOperate,
  resumeProfile,
  onCommand,
  onResume,
  onOpen,
}: {
  detail: typeof FoundrySandboxDetail.Type;
  busy: boolean;
  canOperate: boolean;
  resumeProfile?: string | undefined;
  onCommand: (input: typeof FoundrySandboxMutation.Type) => void;
  onResume: (threadId: ThreadId) => void;
  onOpen: () => void;
}) {
  const [showSetupArchive, setShowSetupArchive] = useState(false);
  const [archiveThread, setArchiveThread] = useState<ThreadId>();
  const { allocation, archiveReceipt, setupLog } = detail;
  const threads = archiveReceipt && "threads" in archiveReceipt ? archiveReceipt.threads : [];
  const setupArtifact =
    archiveReceipt && "archive" in archiveReceipt && archiveReceipt.archive.kind === "setup"
      ? archiveReceipt.archive.artifact
      : null;
  const selected = threads.find((thread) => thread.manifest.owner.threadId === archiveThread);
  const terminal = allocation.state === "deleted";
  const maxExpiry = allocation.createdAt + allocation.profile.maxLifetimeSeconds * 1000;
  const extension = Math.min(maxExpiry, allocation.expiresAt + 60 * 60 * 1000);
  return (
    <section className="space-y-5 rounded-lg border bg-muted/10 p-4" aria-label="Sandbox details">
      <dl className="grid gap-1 text-sm">
        <div>
          <dt className="inline font-medium">Allocation: </dt>
          <dd className="inline break-all">{allocation.allocationId}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Profile revision: </dt>
          <dd className="inline break-all">{allocation.profile.revision}</dd>
        </div>
        <div>
          <dt className="inline font-medium">
            {allocation.request.resumeAllocationId ? "Profile checkout baseline: " : "Checkout: "}
          </dt>
          <dd className="inline break-all">{allocation.profile.checkout.commit}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Expires: </dt>
          <dd className="inline">{new Date(allocation.expiresAt).toLocaleString()}</dd>
        </div>
        {allocation.request.resumeAllocationId ? (
          <div>
            <dt className="inline font-medium">Continued from: </dt>
            <dd className="inline">{allocation.request.resumeAllocationId}</dd>
            {allocation.request.resumeThreadId ? (
              <>
                <dt className="font-medium">Source thread</dt>
                <dd className="break-all">{allocation.request.resumeThreadId}</dd>
              </>
            ) : null}
          </div>
        ) : null}
      </dl>
      {allocation.failure ? (
        <FoundryUI.Notice>
          {allocation.failure === "capacity"
            ? "Waiting for sandbox capacity."
            : `Sandbox failed: ${allocation.failure}.`}
        </FoundryUI.Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || allocation.state !== "ready" || !allocation.deviceId}
          onClick={onOpen}
        >
          Open environment
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            !canOperate ||
            !["requested", "provisioning", "setup", "ready"].includes(allocation.state)
          }
          onClick={() => onCommand({ action: "stop", allocationId: allocation.allocationId })}
        >
          Stop
        </Button>
        <Button
          variant="outline"
          disabled={busy || !canOperate || allocation.state !== "failed"}
          onClick={() => onCommand({ action: "retry", allocationId: allocation.allocationId })}
        >
          {allocation.deleteRequested ? "Retry archive and cleanup" : "Retry setup"}
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            !canOperate ||
            !["requested", "provisioning", "setup", "ready"].includes(allocation.state) ||
            terminal ||
            allocation.deleteRequested ||
            extension <= allocation.expiresAt
          }
          onClick={() =>
            onCommand({
              action: "extend",
              allocationId: allocation.allocationId,
              expiresAt: extension,
            })
          }
        >
          Extend up to one hour
        </Button>
        <Button
          variant="destructive-outline"
          disabled={busy || !canOperate || terminal || allocation.deleteRequested}
          onClick={() => onCommand({ action: "delete", allocationId: allocation.allocationId })}
        >
          Archive and delete
        </Button>
      </div>
      {allocation.deleteRequested && !terminal ? (
        <p role="status">
          Deletion requested. The environment is retained until its archive is confirmed.
        </p>
      ) : null}
      <details open={allocation.state === "setup" || allocation.state === "failed"}>
        <FoundryUI.Summary>Setup log</FoundryUI.Summary>
        <pre className="mt-3 max-h-72 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
          {setupLog || "No setup output received yet."}
        </pre>
      </details>
      {archiveReceipt ? (
        <div className="space-y-2">
          <p className="text-sm">
            Central archive confirmed · {archiveReceipt.digest.slice(0, 12)}
          </p>
          {threads.length ? (
            <p className="text-sm">
              {resumeProfile
                ? `Resume using selected profile: ${resumeProfile}. Archived files retain their source Git state.`
                : "Select an enabled profile before resuming."}
            </p>
          ) : null}
          {threads.map(({ manifest }) => (
            <div className="space-y-3 rounded-lg border bg-card p-4" key={manifest.owner.threadId}>
              <p className="break-all text-xs text-muted-foreground">
                Source thread · {manifest.owner.threadId}
              </p>
              <ArchiveMetadata manifest={manifest} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveThread(manifest.owner.threadId)}
              >
                Open archive
              </Button>
              <Button
                size="sm"
                disabled={busy || !canOperate || !resumeProfile}
                onClick={() => onResume(manifest.owner.threadId)}
              >
                Resume in new environment
              </Button>
            </div>
          ))}
          {"archive" in archiveReceipt ? (
            <p className="text-sm">
              {archiveReceipt.archive.kind === "empty"
                ? "The environment contained no workspace files."
                : "Setup workspace snapshot retained centrally."}
            </p>
          ) : null}
          {setupArtifact ? (
            <Button variant="outline" onClick={() => setShowSetupArchive(true)}>
              Open setup archive
            </Button>
          ) : null}
          {showSetupArchive && setupArtifact ? (
            <SandboxSetupArchive
              manifest={setupArtifact}
              onClose={() => setShowSetupArchive(false)}
            />
          ) : null}
          {selected ? (
            <ThreadArchiveLibrary
              key={selected.manifest.owner.threadId}
              initialOwner={selected.manifest.owner}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ArchiveMetadata({
  manifest,
}: {
  manifest: FoundrySandboxArchiveManifest & {
    remoteBase?: { format: "foundry-remote-delta-2"; url: string; commit: string };
    bundleSizeBytes?: number;
  };
}) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted-foreground">Archive format</dt>
        <dd className="mt-1 font-medium">
          {manifest.remoteBase ? "Remote base + local delta" : "Legacy full bundle"}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {manifest.remoteBase ? "Delta size" : "Bundle size"}
        </dt>
        <dd className="mt-1 tabular-nums">
          {manifest.bundleSizeBytes === undefined
            ? "Unknown · bundle index not loaded"
            : formatAttachmentSize(manifest.bundleSizeBytes)}
        </dd>
      </div>
      {manifest.remoteBase ? (
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Required remote base commit</dt>
          <dd className="mt-1 break-all font-mono text-xs leading-5">
            {manifest.remoteBase.commit}
          </dd>
          <dd className="mt-1 text-xs leading-5 text-muted-foreground">
            Resume requires access to the exact archived base in the source remote.
          </dd>
        </div>
      ) : null}
      <div className="min-w-0 sm:col-span-2">
        <dt className="text-xs text-muted-foreground">Archived HEAD</dt>
        <dd className="mt-1 break-all font-mono text-xs leading-5">{manifest.headCommit}</dd>
      </div>
    </dl>
  );
}
