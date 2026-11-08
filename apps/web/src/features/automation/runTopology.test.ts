import { expect, it } from "vite-plus/test";
import type { AutomationWorkflowVersion } from "@t3tools/contracts";
import { runTopology } from "./runTopology";

it("keeps unequal branch dependencies, the explicit join and serial follow-up distinct", () => {
  const workflow: AutomationWorkflowVersion = {
    id: "workflow",
    factoryId: "factory",
    factoryVersionId: "version",
    execution: {
      mode: "parallel",
      maxParallelism: 2,
      maxRepairRounds: 1,
      join: "all_succeeded",
      failurePolicy: "repair_failed",
      joinStepId: "combine",
    },
    steps: [
      { id: "inspect", kind: "agent", prompt: "Inspect", dependsOn: [] },
      { id: "test-plan", kind: "agent", prompt: "Plan tests", dependsOn: [] },
      { id: "implement", kind: "agent", prompt: "Implement", dependsOn: ["inspect"] },
      { id: "combine", kind: "agent", prompt: "Combine", dependsOn: ["implement", "test-plan"] },
      { id: "approve", kind: "approval", prompt: "Approve", dependsOn: ["combine"] },
    ],
  };
  const topology = runTopology(workflow);
  expect(topology?.levels).toEqual([["inspect", "test-plan"], ["implement"]]);
  expect(topology?.join.id).toBe("combine");
  expect(topology?.join.dependsOn).toEqual(["implement", "test-plan"]);
  expect(topology?.suffix.map((step) => step.id)).toEqual(["approve"]);
  expect(runTopology({ ...workflow, execution: undefined })).toBeNull();
});
