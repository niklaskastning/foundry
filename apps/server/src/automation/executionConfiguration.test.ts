import { expect, it } from "vite-plus/test";
import {
  type AutomationWorkflowVersion,
  type FoundryWorkerStatus,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { executionConfigurationIssue } from "./executionConfiguration.ts";

it("rejects nested unsupported v4 resources and execution capabilities before dispatch", () => {
  const workflow: AutomationWorkflowVersion = {
    id: "workflow",
    factoryId: "factory",
    factoryVersionId: "version",
    steps: [],
    v4: {
      files: [],
      agents: [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Reviews",
          instructions: "Review",
          skills: [],
          mcp: [],
        },
      ],
      skills: [],
      mcp: [],
      workflow: {
        id: "review",
        limits: { maxConcurrentAgents: 2, maxAgentExecutions: 4 },
        steps: [
          {
            id: "swarm",
            kind: "swarm",
            dependsOn: [],
            maxParallel: 2,
            join: { policy: "all", onFailure: "collect" },
            steps: [
              {
                id: "review",
                kind: "agent",
                agent: "reviewer",
                dependsOn: [],
                instructions: "Review",
                execution: { model: "review-model", options: { reasoningEffort: "high" } },
              },
            ],
          },
        ],
      },
    },
  };
  const status: FoundryWorkerStatus = {
    online: true,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerReady: true,
    providerState: "ready",
    version: "fixture",
    checkedAt: "2026-11-05T00:00:00Z",
    capacityAvailable: true,
    activeRuns: 0,
    definitionExecutionVersion: 4,
    models: [{ id: "review-model", aliases: [], reasoningEfforts: ["high"] }],
  };
  expect(executionConfigurationIssue(workflow, status, "review-model")).toBeNull();
  expect(
    executionConfigurationIssue(
      workflow,
      { ...status, definitionExecutionVersion: undefined },
      "review-model",
    ),
  ).toBe("worker_not_ready");
  expect(executionConfigurationIssue(workflow, { ...status, models: [] }, "review-model")).toBe(
    "invalid_execution",
  );
  expect(
    executionConfigurationIssue(
      workflow,
      { ...status, models: [{ id: "review-model", aliases: [], reasoningEfforts: ["low"] }] },
      "review-model",
    ),
  ).toBe("invalid_execution");
  expect(
    executionConfigurationIssue(
      { ...workflow, v4: { ...workflow.v4!, agents: [] } },
      status,
      "review-model",
    ),
  ).toBe("invalid_execution");
  expect(
    executionConfigurationIssue(
      {
        ...workflow,
        v4: { ...workflow.v4!, agents: [{ ...workflow.v4!.agents[0]!, skills: ["missing"] }] },
      },
      status,
      "review-model",
    ),
  ).toBe("invalid_execution");
});
