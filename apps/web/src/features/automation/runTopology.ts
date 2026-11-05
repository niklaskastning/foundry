import type { AutomationWorkflowVersion } from "@t3tools/contracts";

export function runTopology(workflow: AutomationWorkflowVersion) {
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
