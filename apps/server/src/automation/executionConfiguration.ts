import { AutomationWorkflowVersion, type FoundryWorkerStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isWorkflow = Schema.is(AutomationWorkflowVersion);

export function executionConfigurationIssue(
  workflow: AutomationWorkflowVersion,
  status?: FoundryWorkerStatus,
  fallbackModel?: string,
): "invalid_execution" | "unsupported_provider" | "worker_not_ready" | null {
  if (!isWorkflow(workflow)) return "invalid_execution";
  const agents = workflow.steps.filter((step) => step.kind === "agent");
  if (
    agents.some(
      (step) =>
        (step.role !== undefined || step.skills !== undefined || step.execution !== undefined) &&
        !step.resolved,
    )
  )
    return "invalid_execution";
  if (
    agents.some(
      (step) =>
        step.resolved &&
        ((step.role !== undefined && step.resolved.role?.id !== step.role) ||
          step.skills?.some((id) => !step.resolved!.skills.some((skill) => skill.id === id))),
    )
  )
    return "invalid_execution";
  if (status?.providerState === "unsupported_provider") return "unsupported_provider";
  if (
    status &&
    (!status.providerReady ||
      (workflow.execution !== undefined && status.parallelExecutionVersion !== 1) ||
      (agents.some((step) => step.resolved) && status.roleExecutionVersion !== 1))
  )
    return "worker_not_ready";
  if (status) {
    if (agents.some((step) => step.resolved) && !status.models) return "worker_not_ready";
    if (status.models && fallbackModel) {
      for (const step of workflow.steps) {
        if (step.kind !== "agent" && step.kind !== "test") continue;
        const execution = step.kind === "agent" ? step.resolved?.execution : undefined;
        const name = execution?.model ?? fallbackModel;
        const model = status.models.find(
          (model) => model.id === name || model.aliases.includes(name),
        );
        if (
          !model ||
          (execution?.options?.reasoningEffort &&
            !model.reasoningEfforts.includes(execution.options.reasoningEffort))
        )
          return "invalid_execution";
      }
    }
  }
  return null;
}
