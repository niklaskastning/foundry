import type {
  AutomationWorkflowVersion,
  FactoryV4Condition,
  FactoryV4Operand,
  FactoryV4Snapshot,
} from "@t3tools/contracts";
import type {
  FactoryV4Checkpoint,
  FactoryV4NodeState,
  FactoryV4RunState,
} from "../../../../packages/contracts/src/automation/executionV4.ts";
import type * as Schema from "effect/Schema";
import type { DispatchAttempt } from "./DispatchStore.ts";

type Json = typeof Schema.Json.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type NodeState = Mutable<FactoryV4NodeState>;
type State = Omit<Mutable<FactoryV4RunState>, "nodes"> & { nodes: NodeState[] };
const terminal = (status: string) =>
  ["succeeded", "failed", "skipped", "blocked", "cancelled"].includes(status);
const object = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fault = (reason: string): never => {
  throw new Error(reason);
};

export const resolveOperand = (operand: FactoryV4Operand, context: Json): Json => {
  if ("value" in operand) return operand.value;
  const parts = operand.ref.split(".");
  if (
    !parts.length ||
    parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))
  )
    return fault("invalid_reference");
  let value = context;
  for (const part of parts) {
    if (!object(value) || !Object.hasOwn(value, part)) return fault("missing_reference");
    value = value[part]!;
  }
  return value;
};
const equal = (left: Json, right: Json): boolean => {
  if (
    typeof left !== typeof right ||
    Array.isArray(left) !== Array.isArray(right) ||
    (left === null) !== (right === null)
  )
    return fault("condition_type");
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => equal(value, right[index]!))
    );
  if (object(left) && object(right))
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key]!, right[key]!))
    );
  return left === right;
};
export const evaluateCondition = (condition: FactoryV4Condition, context: Json): boolean => {
  if ("eq" in condition)
    return equal(
      resolveOperand(condition.eq[0], context),
      resolveOperand(condition.eq[1], context),
    );
  if ("ne" in condition)
    return !equal(
      resolveOperand(condition.ne[0], context),
      resolveOperand(condition.ne[1], context),
    );
  if ("all" in condition) return condition.all.every((child) => evaluateCondition(child, context));
  if ("any" in condition) return condition.any.some((child) => evaluateCondition(child, context));
  if ("not" in condition) return !evaluateCondition(condition.not, context);
  try {
    resolveOperand(condition.exists, context);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "missing_reference") return false;
    throw error;
  }
};
const values = (mapping: Readonly<Record<string, FactoryV4Operand>> | undefined, context: Json) =>
  Object.fromEntries(
    Object.entries(mapping ?? {}).map(([key, operand]) => [key, resolveOperand(operand, context)]),
  );
const result = (node: FactoryV4NodeState): Json => ({
  status: node.status,
  ...(node.output !== undefined ? { output: node.output } : {}),
  ...(node.checkpoint ? { artifacts: { checkpoint: node.checkpoint } } : {}),
});
const localResults = (state: State, scope: string): Record<string, Json> =>
  Object.fromEntries(
    state.nodes
      .filter((node) => node.scope === scope)
      .map((node) => [node.definition.id, result(node)]),
  );
const context = (state: State, scope: string): Json => {
  const loop = state.nodes
    .filter((node) => node.definition.kind === "loop" && scope.startsWith(`${node.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return {
    inputs: state.inputs,
    steps: localResults(state, scope),
    ...(loop
      ? {
          iteration: loop.iteration ?? 1,
          carry: loop.carry ?? {},
          ...(loop.previous !== undefined ? { previous: loop.previous } : {}),
        }
      : {}),
  };
};
const addScope = (
  state: State,
  definitions: readonly FactoryV4NodeState["definition"][],
  scope: string,
  base: string,
  checkpoint?: FactoryV4Checkpoint,
) => {
  for (const definition of definitions) {
    const path = scope ? `${scope}/${definition.id}` : definition.id;
    if (!state.nodes.some((node) => node.path === path))
      state.nodes.push({
        path,
        scope,
        definition,
        status: "pending",
        base,
        ...(checkpoint ? { workspaceCheckpoint: checkpoint } : {}),
        ...(definition.kind !== "loop" && definition.kind !== "swarm"
          ? { ordinal: state.nodes.filter((node) => node.ordinal !== undefined).length }
          : {}),
      });
  }
};
export const initializeV4 = (
  snapshot: FactoryV4Snapshot,
  base: string,
  inputs: Record<string, Json> = {},
): FactoryV4RunState => {
  const state: State = { nodes: [], startedAgentExecutions: 0, status: "running", inputs };
  addScope(state, snapshot.workflow.steps, "", base);
  return state;
};
const childScope = (node: FactoryV4NodeState) =>
  node.definition.kind === "loop" ? `${node.path}/iteration-${node.iteration ?? 1}` : node.path;
const failureReason = (error: unknown) =>
  error instanceof Error &&
  ["missing_reference", "invalid_reference", "condition_type", "checkpoint_required"].includes(
    error.message,
  )
    ? error.message
    : "invalid_result";
const checkpointValue = (value: Json, state: State): FactoryV4Checkpoint => {
  if (!object(value)) return fault("checkpoint_required");
  const found = state.nodes.find((node) => node.checkpoint && equal(node.checkpoint, value));
  return found?.checkpoint ?? fault("checkpoint_required");
};

export const reconcileV4 = (
  snapshot: FactoryV4Snapshot,
  saved: FactoryV4RunState,
  attempts: readonly DispatchAttempt[],
  mode: string,
): FactoryV4RunState => {
  const cloned = structuredClone(saved);
  const state: State = { ...cloned, nodes: cloned.nodes.map((node) => ({ ...node })) };
  const latest = new Map(attempts.map((attempt) => [attempt.ordinal, attempt]));
  for (const node of state.nodes) {
    if (node.ordinal === undefined) continue;
    const attempt = latest.get(node.ordinal);
    if (!attempt) continue;
    if (attempt.state === "succeeded" || attempt.state === "failed") {
      if (attempt.capacityReleased === false) continue;
      const retry =
        node.definition.kind === "agent" || node.definition.kind === "test"
          ? (node.definition.retry?.maxAttempts ?? 1)
          : 1;
      node.status =
        attempt.state === "failed" &&
        attempt.reason === "worker_failed" &&
        !node.cancelRequested &&
        mode === "active" &&
        (attempt.attemptNumber ?? 0) + 1 < retry
          ? "ready"
          : attempt.state;
      if (attempt.reason) node.reason = attempt.reason;
      const data = attempt.result;
      if (object(data)) {
        if (data.output !== undefined && attempt.state === "succeeded") node.output = data.output;
        if (object(data.checkpoint) && attempt.state === "succeeded") {
          const checkpoint = data.checkpoint;
          if (
            typeof checkpoint.commitSha === "string" &&
            typeof checkpoint.commandId === "string" &&
            typeof checkpoint.generation === "number" &&
            typeof checkpoint.workerId === "string"
          )
            node.checkpoint = {
              commitSha: checkpoint.commitSha,
              commandId: checkpoint.commandId,
              generation: checkpoint.generation,
              workerId: checkpoint.workerId,
            };
        }
      }
    } else node.status = "running";
  }
  if (state.startedAgentExecutions >= snapshot.workflow.limits.maxAgentExecutions) {
    for (const node of state.nodes) {
      if (
        node.status === "ready" &&
        (node.definition.kind === "agent" || node.definition.kind === "test")
      ) {
        node.status = "failed";
        node.reason = "budget_exhausted";
        state.reason = "budget_exhausted";
      }
    }
  }
  const cancelTree = (parent: NodeState) => {
    for (const node of state.nodes.filter((node) => node.path.startsWith(`${parent.path}/`))) {
      if (terminal(node.status)) continue;
      if (node.ordinal !== undefined && latest.has(node.ordinal)) node.cancelRequested = true;
      else if (node.definition.kind !== "loop" && node.definition.kind !== "swarm")
        node.status = "cancelled";
    }
  };
  if (mode === "cancel_requested" || mode === "cancelled") {
    for (const node of state.nodes) {
      if (terminal(node.status)) continue;
      if (node.ordinal !== undefined && latest.has(node.ordinal)) node.cancelRequested = true;
      else if (node.definition.kind !== "loop" && node.definition.kind !== "swarm")
        node.status = "cancelled";
    }
  }
  for (let pass = 0; pass < 100; pass++) {
    const before = JSON.stringify(state);
    if (state.nodes.some((node) => node.reason === "budget_exhausted")) {
      for (const node of state.nodes)
        if (node.status === "pending" || node.status === "ready") {
          node.status = "blocked";
          node.reason = "budget_exhausted";
        }
    }

    for (const node of [...state.nodes].reverse()) {
      if (terminal(node.status)) continue;
      const definition = node.definition;
      try {
        if (node.status === "pending") {
          if (mode !== "active") continue;
          const dependencies = definition.dependsOn.map((id) =>
            state.nodes.find((other) => other.scope === node.scope && other.definition.id === id),
          );
          if (dependencies.some((dependency) => !dependency || !terminal(dependency.status)))
            continue;
          if (definition.dependencyPolicy !== "terminal") {
            if (
              dependencies.some(
                (dependency) =>
                  dependency && ["failed", "blocked", "cancelled"].includes(dependency.status),
              )
            ) {
              node.status = "blocked";
              node.reason = "dependency_failed";
              continue;
            }
            if (dependencies.some((dependency) => dependency?.status === "skipped")) {
              node.status = "skipped";
              node.reason = "dependency_skipped";
              continue;
            }
          }
          if (definition.when && node.condition === undefined)
            node.condition = evaluateCondition(definition.when, context(state, node.scope));
          if (node.condition === false) {
            node.status = "skipped";
            continue;
          }
          if (definition.kind === "loop") {
            node.iteration = 1;
            node.carry = values(definition.carry, context(state, node.scope));
            node.status = "running";
            addScope(
              state,
              definition.steps,
              childScope(node),
              node.base,
              node.checkpoint ?? node.workspaceCheckpoint,
            );
          } else if (definition.kind === "swarm") {
            node.status = "running";
            addScope(state, definition.steps, node.path, node.base, node.workspaceCheckpoint);
          } else {
            if (definition.kind === "agent")
              node.inputs = values(definition.inputs, context(state, node.scope));
            if (
              (definition.kind === "agent" || definition.kind === "test") &&
              definition.workspace?.from
            ) {
              node.workspaceCheckpoint = checkpointValue(
                resolveOperand(definition.workspace.from, context(state, node.scope)),
                state,
              );
              node.base = node.workspaceCheckpoint.commitSha;
            }
            node.status = "ready";
            if (
              (definition.kind === "agent" || definition.kind === "test") &&
              state.startedAgentExecutions >= snapshot.workflow.limits.maxAgentExecutions
            ) {
              node.status = "failed";
              node.reason = "budget_exhausted";
              state.reason = "budget_exhausted";
            }
          }
        }
        if (definition.kind !== "loop" && definition.kind !== "swarm") continue;
        if (node.status !== "running" && node.status !== "waiting") continue;
        const children = state.nodes.filter((child) => child.scope === childScope(node));
        if (!children.length) continue;
        if (definition.kind === "swarm") {
          const successes = children.filter((child) => child.status === "succeeded").length;
          const pending = children.filter((child) => !terminal(child.status)).length;
          const needed =
            definition.join.policy === "all" ? children.length : definition.join.minSuccesses;
          if (successes + pending < needed && definition.join.onFailure === "cancel_remaining")
            cancelTree(node);
          if (children.some((child) => !terminal(child.status))) continue;
          node.status = successes >= needed ? "succeeded" : "failed";
          if (node.status === "succeeded")
            node.output = { members: localResults(state, node.path) };
          if (node.status === "failed") node.reason = "join_failed";
          continue;
        }
        if (children.some((child) => !terminal(child.status))) continue;
        if (children.some((child) => ["failed", "blocked", "cancelled"].includes(child.status))) {
          node.status = "failed";
          node.reason = "iteration_failed";
          continue;
        }
        if (node.approvalPath) {
          const approval = state.nodes.find((other) => other.path === node.approvalPath);
          if (approval?.status === "succeeded") {
            node.status = "succeeded";
            node.output = {
              iterations: node.iteration!,
              reason: "accepted",
              last: localResults(state, childScope(node)),
            };
          }
          continue;
        }
        const writers = children.filter(
          (child) =>
            child.definition.kind === "agent" && child.definition.workspace?.access === "write",
        );
        const source = definition.workspaceFrom
          ? children.find((child) => child.definition.id === definition.workspaceFrom)
          : writers.length === 1
            ? writers[0]
            : undefined;
        if (source) {
          if (!source.checkpoint) fault("checkpoint_required");
          node.checkpoint = source.checkpoint;
        }
        node.until = evaluateCondition(definition.until, context(state, childScope(node)));
        if (node.until) {
          node.status = "succeeded";
          node.output = {
            iterations: node.iteration!,
            reason: "until",
            last: localResults(state, childScope(node)),
          };
          continue;
        }
        if (node.iteration! >= definition.maxIterations) {
          if (definition.onExhausted === "fail") {
            node.status = "failed";
            node.reason = "iterations_exhausted";
          } else {
            const path = `${node.path}/exhausted-approval`;
            node.approvalPath = path;
            node.status = "waiting";
            state.nodes.push({
              path,
              scope: node.path,
              definition: {
                id: "exhausted-approval",
                kind: "approval",
                instructions: "Accept the exhausted loop result or cancel the run.",
                dependsOn: [],
              },
              status: "ready",
              base: node.base,
              ordinal: state.nodes.filter((other) => other.ordinal !== undefined).length,
            });
          }
          continue;
        }
        if (mode !== "active") continue;
        const nextCarry = values(definition.nextCarry, context(state, childScope(node)));
        if (node.checkpoint) node.base = node.checkpoint.commitSha;
        node.previous = { steps: localResults(state, childScope(node)) };
        node.carry = nextCarry;
        node.iteration = node.iteration! + 1;
        delete node.until;
        addScope(
          state,
          definition.steps,
          childScope(node),
          node.base,
          node.checkpoint ?? node.workspaceCheckpoint,
        );
      } catch (error) {
        node.status = "failed";
        node.reason = failureReason(error);
      }
    }
    if (JSON.stringify(state) === before) break;
  }
  const roots = state.nodes.filter((node) => node.scope === "");
  if (roots.every((node) => terminal(node.status))) {
    const budgetExhausted = state.nodes.some((node) => node.reason === "budget_exhausted");
    state.status =
      budgetExhausted ||
      roots.some((node) => ["failed", "blocked", "cancelled"].includes(node.status))
        ? "failed"
        : "succeeded";
    state.reason =
      state.status === "failed"
        ? budgetExhausted
          ? "budget_exhausted"
          : (state.reason ?? roots.find((node) => node.reason)?.reason ?? "workflow_failed")
        : undefined;
  }
  if (!roots.every((node) => terminal(node.status))) {
    const approval = state.nodes.some(
      (node) =>
        node.status === "ready" &&
        (node.definition.kind === "approval" || node.definition.kind === "publish"),
    );
    state.status = approval ? "waiting" : "running";
    if (approval) state.reason = "approval_required";
  }
  return state;
};

export const readyV4Nodes = (
  snapshot: FactoryV4Snapshot,
  state: FactoryV4RunState,
  attempts: readonly DispatchAttempt[],
) => {
  const active = state.nodes.filter(
    (node) =>
      node.ordinal !== undefined &&
      attempts.some(
        (attempt) => attempt.ordinal === node.ordinal && attempt.capacityReleased === false,
      ),
  );
  return state.nodes.filter((node) => {
    if (node.status !== "ready" || node.cancelRequested) return false;
    if (node.definition.kind !== "agent" && node.definition.kind !== "test") return true;
    if (
      state.startedAgentExecutions >= snapshot.workflow.limits.maxAgentExecutions ||
      active.length >= snapshot.workflow.limits.maxConcurrentAgents
    )
      return false;
    return state.nodes
      .filter(
        (parent) => parent.definition.kind === "swarm" && node.path.startsWith(`${parent.path}/`),
      )
      .every(
        (parent) =>
          parent.definition.kind === "swarm" &&
          active.filter((child) => child.path.startsWith(`${parent.path}/`)).length <
            parent.definition.maxParallel,
      );
  });
};

export const projectV4Steps = (state: FactoryV4RunState): AutomationWorkflowVersion["steps"] =>
  state.nodes
    .filter((node) => node.ordinal !== undefined)
    .sort((a, b) => a.ordinal! - b.ordinal!)
    .map((node) => {
      const common = { id: node.path, dependsOn: [] };
      const definition = node.definition;
      switch (definition.kind) {
        case "agent":
          return { ...common, kind: "agent" as const, prompt: definition.instructions };
        case "test":
          return { ...common, kind: "test" as const, checkId: definition.checkId };
        case "approval":
          return { ...common, kind: "approval" as const, prompt: definition.instructions };
        case "publish":
          return { ...common, kind: "publish" as const, target: definition.target };
        default:
          throw new Error("invalid_leaf");
      }
    });
