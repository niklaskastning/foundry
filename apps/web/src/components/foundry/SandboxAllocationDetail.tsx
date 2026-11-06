import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import type { FoundrySandboxDetail, FoundrySandboxMutation, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { ThreadArchiveLibrary } from "../../foundry/ThreadArchiveLibrary";

export function SandboxAllocationDetail({
  detail,
  busy,
  canOperate,
  onCommand,
  onResume,
  onOpen,
}: {
  detail: typeof FoundrySandboxDetail.Type;
  busy: boolean;
  canOperate: boolean;
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
    <section className="space-y-3" aria-label="Sandbox details">
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
          <dt className="inline font-medium">Checkout: </dt>
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
        <p role="alert">
          {allocation.failure === "capacity"
            ? "Waiting for sandbox capacity."
            : `Sandbox failed: ${allocation.failure}.`}
        </p>
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
          disabled={
            busy || !canOperate || allocation.state !== "failed" || allocation.deleteRequested
          }
          onClick={() => onCommand({ action: "retry", allocationId: allocation.allocationId })}
        >
          Retry setup
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            !canOperate ||
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
        <summary>Setup log</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
          {setupLog || "No setup output received yet."}
        </pre>
      </details>
      {archiveReceipt ? (
        <div className="space-y-2">
          <p className="text-sm">
            Central archive confirmed · {archiveReceipt.digest.slice(0, 12)}
          </p>
          {threads.map(({ manifest }) => (
            <div className="flex flex-wrap items-center gap-2" key={manifest.owner.threadId}>
              <span className="text-xs">{manifest.owner.threadId}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveThread(manifest.owner.threadId)}
              >
                Open archive
              </Button>
              <Button
                size="sm"
                disabled={busy || !canOperate}
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
            <div className="flex h-96 flex-col overflow-hidden rounded-lg border">
              <AttachmentFilePreview
                name={setupArtifact.name}
                mimeType={setupArtifact.mimeType}
                sizeBytes={setupArtifact.sizeBytes}
                asset={{
                  environmentId: setupArtifact.reference.owner.environmentId,
                  attachmentId: setupArtifact.reference.artifactId,
                  foundryArtifact: setupArtifact,
                }}
                onClose={() => setShowSetupArchive(false)}
              />
            </div>
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
