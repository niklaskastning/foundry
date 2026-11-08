import type { AutomationApplicationResult, AutomationWorkflowVersion } from "@t3tools/contracts";

export function runTopology(workflow: Pick<AutomationWorkflowVersion, "steps" | "execution">) {
  if (!workflow.execution) return null;
  const joinIndex = workflow.steps.findIndex((step) => step.id === workflow.execution?.joinStepId);
  const levels: string[][] = [];
  const depths = new Map<string, number>();
  for (const step of workflow.steps.slice(0, joinIndex)) {
    const depth = step.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, (depths.get(dependency) ?? -1) + 1),
      0,
    );
    depths.set(step.id, depth);
    (levels[depth] ??= []).push(step.id);
  }
  return {
    levels,
    joinIndex,
    join: workflow.steps[joinIndex]!,
    suffix: workflow.steps.slice(joinIndex + 1),
  };
}

export function runStatusVariant(state: string) {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "blocked") return "error";
  if (state === "waiting" || state === "paused" || state === "cancel_requested") return "warning";
  if (state === "running" || state === "ready") return "info";
  return "secondary";
}

export function runScopeLabel(scope: string) {
  return scope
    ? scope
        .split("/")
        .map((part) => part.replace(/^iteration-(\d+)$/, "Review round $1"))
        .join(" / ")
    : "Workflow";
}

type RunDetail = Extract<AutomationApplicationResult, { kind: "run" }>;
export function runExecutionStep(
  detail: Pick<RunDetail, "runtimeState" | "runtimeWorkflow" | "workflow">,
  ordinal: number,
) {
  const node = detail.runtimeState?.nodes.find((item) => item.ordinal === ordinal);
  const step = detail.runtimeWorkflow
    ? detail.workflow.steps.find((item) => item.id === node?.path)
    : detail.workflow.steps[ordinal];
  return { node, step, label: node?.definition.id ?? step?.id ?? `Execution ${ordinal + 1}` };
}

export function runReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    iterations_exhausted:
      "Review rounds reached their limit. Inspect the last result before starting new work.",
    dependency_failed: "Blocked because a required earlier step failed.",
    budget_exhausted:
      "The execution budget is exhausted. Review completed results before starting new work.",
    condition_false: "Skipped because this step's condition was not met.",
  };
  return labels[reason] ?? reason.replaceAll("_", " ");
}
