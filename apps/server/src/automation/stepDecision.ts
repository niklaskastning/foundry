import type {
  FoundryArchiveEvent,
  FoundryArchiveStatus,
  FoundryWorkerExecution,
  FoundryPublishRequest,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ProviderTurnJson,
} from "@t3tools/contracts";

export type StepDecision = {
  readonly state: "running" | "waiting" | "finalizing" | "failed" | "succeeded";
  readonly reason: string | null;
};

export const decideStep = (input: {
  readonly execution: FoundryWorkerExecution;
  readonly archive: FoundryArchiveStatus | null;
  readonly events: ReadonlyArray<FoundryArchiveEvent>;
  readonly command?: string;
  readonly cwd?: string;
  readonly workspaceRelative?: boolean;
  readonly artifactsReady: boolean;
  readonly publishRequest?: typeof FoundryPublishRequest.Type;
}): StepDecision => {
  const { execution, archive, events } = input;
  const lifecycle = execution.lifecycle;
  if (!lifecycle?.writerEnded)
    return {
      state: execution.run.status === "waiting" ? "waiting" : "running",
      reason: "writer_end_pending",
    };
  if (["failed", "interrupted", "cancelled", "rolled_back"].includes(execution.run.status))
    return { state: "failed", reason: "worker_failed" };
  const manifest = lifecycle.manifest;
  if (execution.run.status !== "completed" || !manifest)
    return { state: "finalizing", reason: "worker_result_pending" };
  if (
    manifest.outcome !== "completed" ||
    manifest.generation !== lifecycle.generation ||
    manifest.runId !== execution.run.id
  )
    return { state: "finalizing", reason: "worker_result_mismatch" };
  if (
    !manifest.checkpointId ||
    !manifest.checkpointRef ||
    execution.run.checkpointId !== manifest.checkpointId
  )
    return { state: "finalizing", reason: "checkpoint_pending" };
  if (manifest.publishEvidenceFailure)
    return {
      state: "failed",
      reason: `publish_${manifest.publishEvidenceFailure}`,
    };
  const final = manifest.archive;
  if (
    !final ||
    !archive ||
    !archive.complete ||
    !archive.sourceComplete ||
    archive.missingAttachmentCount !== 0 ||
    archive.missingArtifacts.length !== 0 ||
    archive.confirmedCursor < final.cursor ||
    archive.confirmedSourceSequence < final.sourceSequence
  )
    return { state: "finalizing", reason: "archive_pending" };
  if (
    archive.owner.threadId !== execution.receipt.threadId ||
    archive.owner.threadId !== final.owner.threadId ||
    archive.owner.environmentId !== final.owner.environmentId
  )
    return { state: "finalizing", reason: "archive_mismatch" };
  let sequence = 0;
  let sourceSequence = 0;
  let runConfirmed = false;
  let checkpointConfirmed = false;
  let runAttemptId: string | null = null;
  const commands = new Map<string, OrchestrationV2TurnItemJson>();
  const turns = new Map<string, OrchestrationV2ProviderTurnJson>();
  for (const entry of events) {
    if (entry.sequence > final.cursor) break;
    if (entry.sequence !== sequence + 1 || entry.sourceSequence <= sourceSequence)
      return { state: "finalizing", reason: "archive_gap" };
    sequence = entry.sequence;
    sourceSequence = entry.sourceSequence;
    const event = entry.event;
    if (event.type === "run.updated" && event.payload.id === execution.run.id) {
      runConfirmed =
        event.payload.status === "completed" &&
        event.payload.checkpointId === manifest.checkpointId;
      runAttemptId = event.payload.activeAttemptId;
    }
    if (event.type === "checkpoint.captured" && event.payload.id === manifest.checkpointId)
      checkpointConfirmed =
        event.payload.status === "ready" &&
        event.payload.ref === manifest.checkpointRef &&
        event.payload.runId === execution.run.id &&
        event.payload.threadId === execution.receipt.threadId;
    if (event.type === "provider-turn.updated") turns.set(event.payload.id, event.payload);
    if (
      event.type === "turn-item.updated" &&
      event.payload.runId === execution.run.id &&
      event.payload.type === "command_execution"
    )
      commands.set(event.payload.id, event.payload);
  }
  if (
    sequence !== final.cursor ||
    sourceSequence !== final.sourceSequence ||
    !runConfirmed ||
    !checkpointConfirmed
  )
    return { state: "finalizing", reason: "required_events_pending" };
  if (!input.artifactsReady) return { state: "finalizing", reason: "artifacts_pending" };
  if (
    input.workspaceRelative &&
    input.command !== undefined &&
    (input.cwd !== "." || !manifest.workspacePath)
  )
    return { state: "finalizing", reason: "test_workspace_pending" };
  if (input.publishRequest) {
    const requested = input.publishRequest;
    const evidence = manifest.publishEvidence;
    if (
      !evidence ||
      evidence.repository !== requested.repository ||
      evidence.baseBranch !== requested.baseBranch ||
      (input.workspaceRelative && evidence.sourceCwd !== manifest.workspacePath) ||
      requested.checks.length === 0 ||
      !requested.checks.some(
        (check) => check.command === input.command && check.cwd === input.cwd,
      ) ||
      evidence.checks.length !== requested.checks.length ||
      new Set(requested.checks.map((check) => check.id)).size !== requested.checks.length ||
      new Set(evidence.checks.map((check) => check.id)).size !== evidence.checks.length ||
      requested.checks.some((check) => {
        const confirmed = evidence.checks.find((item) => item.id === check.id);
        return (
          !confirmed ||
          confirmed.command !== check.command ||
          confirmed.cwd !== check.cwd ||
          confirmed.exitCode !== 0 ||
          confirmed.commitSha !== evidence.commitSha ||
          confirmed.treeSha !== evidence.treeSha
        );
      }) ||
      evidence.bundle.reference.instanceId !== final.instanceId ||
      evidence.bundle.reference.owner.environmentId !== final.owner.environmentId ||
      evidence.bundle.reference.owner.threadId !== execution.receipt.threadId
    )
      return { state: "finalizing", reason: "publish_evidence_mismatch" };
    if (
      !runAttemptId ||
      ![...turns.values()].some(
        (turn) => turn.runAttemptId === runAttemptId && turn.status === "completed",
      )
    )
      return { state: "finalizing", reason: "test_attempt_pending" };
    return { state: "succeeded", reason: null };
  }
  if (input.command !== undefined) {
    const matching = [...commands.values()].filter(
      (item) =>
        item.type === "command_execution" &&
        item.input === input.command &&
        item.cwd === (input.workspaceRelative ? manifest.workspacePath : input.cwd) &&
        item.threadId === execution.receipt.threadId,
    );
    if (
      matching.some(
        (item) =>
          item.type === "command_execution" &&
          (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)),
      )
    )
      return { state: "failed", reason: "test_failed" };
    if (
      matching.length !== 1 ||
      matching[0]?.type !== "command_execution" ||
      matching[0].exitCode !== 0 ||
      matching[0].status !== "completed" ||
      matching[0].completedAt === null
    )
      return { state: "finalizing", reason: "test_result_pending" };
    const turn = matching[0].providerTurnId ? turns.get(matching[0].providerTurnId) : undefined;
    if (!runAttemptId || !turn || turn.runAttemptId !== runAttemptId || turn.status !== "completed")
      return { state: "finalizing", reason: "test_attempt_pending" };
  }
  return { state: "succeeded", reason: null };
};
