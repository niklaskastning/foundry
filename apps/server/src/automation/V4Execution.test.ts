import { describe, expect, it } from "@effect/vitest";
import { evaluateCondition, resolveOperand } from "./V4Execution.ts";

describe("v4 data evaluation", () => {
  it("short circuits optional values but rejects missing and mismatched operands", () => {
    const scope = { inputs: {}, steps: {}, iteration: 1, carry: {} };
    expect(
      evaluateCondition(
        {
          all: [
            { exists: { ref: "inputs.optional" } },
            { eq: [{ ref: "inputs.optional" }, { value: true }] },
          ],
        },
        scope,
      ),
    ).toBe(false);
    expect(() =>
      evaluateCondition({ eq: [{ ref: "inputs.optional" }, { value: false }] }, scope),
    ).toThrow("missing_reference");
    expect(() => evaluateCondition({ ne: [{ value: 1 }, { value: "1" }] }, scope)).toThrow(
      "condition_type",
    );
    expect(() => resolveOperand({ ref: "inputs.__proto__" }, scope)).toThrow("invalid_reference");
  });
});

import { initializeV4, readyV4Nodes, reconcileV4 } from "./V4Execution.ts";
import type { FactoryV4Node, FactoryV4Snapshot } from "@t3tools/contracts";
import type { DispatchAttempt } from "./DispatchStore.ts";
const agent = (
  id: string,
  extra: Partial<Extract<FactoryV4Node, { kind: "agent" }>> = {},
): FactoryV4Node => ({
  id,
  kind: "agent",
  agent: "worker",
  instructions: id,
  dependsOn: [],
  ...extra,
});
const snapshot = (steps: FactoryV4Node[]): FactoryV4Snapshot => ({
  workflow: { id: "flow", limits: { maxConcurrentAgents: 2, maxAgentExecutions: 20 }, steps },
  agents: [],
  skills: [],
  mcp: [],
  files: [],
});
const attempt = (
  ordinal: number,
  state: "succeeded" | "failed" | "running",
  output?: Record<string, string>,
  extra: Partial<DispatchAttempt> = {},
): DispatchAttempt => ({
  ordinal,
  commandId: `command-${ordinal}`,
  state,
  reason: state === "failed" ? "worker_failed" : null,
  request: {},
  receipt: null,
  result: {
    ...(output ? { output } : {}),
    checkpoint: {
      commitSha: String(ordinal + 1).repeat(40),
      commandId: `command-${ordinal}`,
      generation: 1,
      workerId: "worker",
    },
  },
  capacityReleased: state !== "running",
  ...extra,
});

describe("v4 control flow", () => {
  it("clears the approval wait reason when the approved dependency starts", () => {
    const flow = snapshot([
      { id: "preflight", kind: "approval", dependsOn: [], instructions: "Approve execution" },
      agent("work", { dependsOn: ["preflight"] }),
    ]);
    let state = reconcileV4(flow, initializeV4(flow, "a".repeat(40)), [], "active");
    expect(state).toMatchObject({ status: "waiting", reason: "approval_required" });
    const rejected = reconcileV4(
      flow,
      structuredClone(state),
      [attempt(0, "failed", undefined, { reason: "approval_rejected" })],
      "active",
    );
    expect(rejected.status).toBe("failed");
    expect(rejected.reason).toBe("approval_rejected");
    state = reconcileV4(flow, state, [attempt(0, "succeeded")], "active");
    expect(state.status).toBe("running");
    expect(state.reason).toBeUndefined();
    state = reconcileV4(
      flow,
      structuredClone(state),
      [attempt(0, "succeeded"), attempt(1, "running")],
      "active",
    );
    expect(state.status).toBe("running");
    expect(state.reason).toBeUndefined();
  });
  it("carries the verified checkpoint through business iterations and cannot reuse an older review", () => {
    const flow = snapshot([
      {
        id: "improve",
        kind: "loop",
        dependsOn: [],
        maxIterations: 2,
        onExhausted: "fail",
        carry: { feedback: { value: "implement" } },
        nextCarry: { feedback: { ref: "steps.review.output.feedback" } },
        until: { eq: [{ ref: "steps.review.output.verdict" }, { value: "approved" }] },
        steps: [
          agent("implement", {
            workspace: { access: "write" },
            inputs: { feedback: { ref: "carry.feedback" } },
          }),
          agent("review", {
            dependsOn: ["implement"],
            workspace: { access: "read", from: { ref: "steps.implement.artifacts.checkpoint" } },
          }),
        ],
      },
    ]);
    let state = reconcileV4(flow, initializeV4(flow, "a".repeat(40)), [], "active");
    expect(readyV4Nodes(flow, state, []).map((node) => node.path)).toEqual([
      "improve/iteration-1/implement",
    ]);
    const first = [
      attempt(0, "succeeded"),
      attempt(1, "succeeded", { verdict: "changes_requested", feedback: "fix" }),
    ];
    state = reconcileV4(flow, state, first, "active");
    expect(state.nodes.find((node) => node.path === "improve/iteration-2/implement")).toMatchObject(
      { base: "1".repeat(40), inputs: { feedback: "fix" }, status: "ready" },
    );
    state = reconcileV4(
      flow,
      JSON.parse(JSON.stringify(state)),
      [...first, attempt(2, "succeeded"), attempt(3, "failed")],
      "active",
    );
    expect(state.status).toBe("failed");
    expect(state.nodes[0]).toMatchObject({ iteration: 2, reason: "iteration_failed" });
  });
  it("counts nested leaves and fences cancelled members before a quorum can finish", () => {
    const flow = snapshot([
      {
        id: "outer",
        kind: "swarm",
        dependsOn: [],
        maxParallel: 1,
        join: { policy: "all", onFailure: "cancel_remaining" },
        steps: [
          {
            id: "inner",
            kind: "swarm",
            dependsOn: [],
            maxParallel: 2,
            join: { policy: "all", onFailure: "collect" },
            steps: [agent("left"), agent("right")],
          },
          agent("other"),
        ],
      },
    ]);
    let state = reconcileV4(flow, initializeV4(flow, "a".repeat(40)), [], "active");
    const left = state.nodes.find((node) => node.definition.id === "left")!;
    const running = attempt(left.ordinal!, "running");
    state = reconcileV4(flow, state, [running], "active");
    expect(readyV4Nodes(flow, state, [running])).toHaveLength(0);
    const other = state.nodes.find((node) => node.definition.id === "other")!;
    state = reconcileV4(flow, state, [running, attempt(other.ordinal!, "failed")], "active");
    expect(state.nodes.find((node) => node.path === left.path)?.cancelRequested).toBe(true);
    expect(state.status).toBe("running");
    state = reconcileV4(
      flow,
      state,
      [attempt(left.ordinal!, "failed"), attempt(other.ordinal!, "failed")],
      "active",
    );
    expect(state.status).toBe("failed");
  });
  it("persists false conditions, terminal dependency policy, technical retry and exhausted budgets", () => {
    const flow = snapshot([
      agent("skip", { when: { eq: [{ value: 1 }, { value: 2 }] } }),
      agent("dependent", { dependsOn: ["skip"] }),
      agent("terminal", {
        dependsOn: ["skip"],
        dependencyPolicy: "terminal",
        retry: { maxAttempts: 2 },
      }),
    ]);
    let state = reconcileV4(flow, initializeV4(flow, "a".repeat(40)), [], "active");
    expect(state.nodes.map((node) => node.status)).toEqual(["skipped", "skipped", "ready"]);
    state = reconcileV4(flow, state, [attempt(2, "failed")], "active");
    expect(state.nodes[2]?.status).toBe("ready");
    state = reconcileV4(
      flow,
      { ...state, startedAgentExecutions: 20 },
      [attempt(2, "failed")],
      "active",
    );
    expect(state).toMatchObject({
      status: "failed",
      reason: "budget_exhausted",
      startedAgentExecutions: 20,
    });
  });
});

it("retains every enclosing iteration index and fences previous nested attempts", () => {
  const flow = snapshot([
    {
      id: "outer",
      kind: "loop",
      dependsOn: [],
      maxIterations: 2,
      onExhausted: "fail",
      until: { eq: [{ ref: "iteration" }, { value: 2 }] },
      steps: [
        {
          id: "inner",
          kind: "loop",
          dependsOn: [],
          maxIterations: 2,
          onExhausted: "fail",
          until: { eq: [{ ref: "iteration" }, { value: 2 }] },
          steps: [agent("inspect")],
        },
      ],
    },
  ]);
  let state = reconcileV4(flow, initializeV4(flow, "a".repeat(40)), [], "active");
  const attempts: DispatchAttempt[] = [];
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const ready = readyV4Nodes(flow, state, attempts);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.path).toBe(
      `outer/iteration-${Math.floor(ordinal / 2) + 1}/inner/iteration-${(ordinal % 2) + 1}/inspect`,
    );
    expect(ready[0]?.ordinal).toBe(ordinal);
    attempts.push(attempt(ordinal, "succeeded"));
    state = reconcileV4(flow, structuredClone(state), attempts, "active");
  }
  expect(state.status).toBe("succeeded");
  expect(state.nodes.filter((node) => node.ordinal !== undefined)).toHaveLength(4);
});

it("ends with budget_exhausted even when a partial quorum otherwise succeeds", () => {
  const flow = snapshot([
    {
      id: "swarm",
      kind: "swarm",
      dependsOn: [],
      maxParallel: 2,
      join: { policy: "quorum", minSuccesses: 1, onFailure: "collect" },
      steps: [agent("left"), agent("right")],
    },
  ]);
  const limited = {
    ...flow,
    workflow: { ...flow.workflow, limits: { maxConcurrentAgents: 2, maxAgentExecutions: 1 } },
  };
  let state = reconcileV4(limited, initializeV4(limited, "a".repeat(40)), [], "active");
  state = reconcileV4(
    limited,
    { ...state, startedAgentExecutions: 1 },
    [attempt(0, "running")],
    "active",
  );
  expect(state).toMatchObject({ status: "running", reason: "budget_exhausted" });
  state = reconcileV4(limited, state, [attempt(0, "succeeded")], "active");
  expect(state).toMatchObject({ status: "failed", reason: "budget_exhausted" });
});
