import * as Schema from "effect/Schema";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const AutomationFactory = Schema.Struct({
  id: Key,
  name: Title,
  archived: Schema.Boolean,
});
export type AutomationFactory = typeof AutomationFactory.Type;
export const AutomationFactoryVersion = Schema.Struct({
  id: Key,
  factoryId: Key,
  repositories: Schema.Array(Key),
});
export type AutomationFactoryVersion = typeof AutomationFactoryVersion.Type;
export const AutomationWorkItemState = Schema.Literals([
  "open",
  "in_progress",
  "review",
  "completed",
  "cancelled",
]);
export const AutomationWorkItem = Schema.Struct({
  id: Key,
  factoryId: Key,
  versionId: Key,
  repository: Key,
  title: Title,
  source: Schema.Struct({ kind: Schema.Literals(["manual", "external"]), reference: Key }),
  state: AutomationWorkItemState,
});
export type AutomationWorkItem = typeof AutomationWorkItem.Type;
export const CreateAutomationFactory = Schema.Struct({ commandId: Key, id: Key, name: Title });
export const CreateAutomationVersion = Schema.Struct({
  commandId: Key,
  id: Key,
  factoryId: Key,
  repositories: Schema.Array(Key),
});
export const CreateAutomationWorkItem = Schema.Struct({
  commandId: Key,
  id: Key,
  factoryId: Key,
  versionId: Key,
  repository: Key,
  title: Title,
  source: AutomationWorkItem.fields.source,
});

const StepText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
export const FactoryAgentExecution = Schema.Struct({
  provider: Schema.optional(Schema.Literal("codex")),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  options: Schema.optional(
    Schema.Struct({
      reasoningEffort: Schema.optional(
        Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
      ),
    }),
  ),
});
export const FactoryAgentSkill = Schema.Struct({
  id: Key,
  name: Title,
  instructions: StepText,
});
export const FactoryAgentRole = Schema.Struct({
  id: Key,
  name: Title,
  description: Title,
  instructions: StepText,
  skills: Schema.Array(Key).check(
    Schema.isMaxLength(100),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  execution: Schema.optional(FactoryAgentExecution),
});
export const FactoryResolvedAgent = Schema.Struct({
  role: Schema.optional(Schema.Struct({ id: Key, name: Title, instructions: StepText })),
  skills: Schema.Array(FactoryAgentSkill).check(Schema.isMaxLength(100)),
  execution: Schema.Struct({ ...FactoryAgentExecution.fields, provider: Schema.Literal("codex") }),
  instructions: Schema.String.check(Schema.isMaxLength(60_000)),
});
const StepFields = { id: Key, dependsOn: Schema.Array(Key) };
const AgentStepFields = {
  ...StepFields,
  kind: Schema.Literal("agent"),
  prompt: StepText,
  role: Schema.optional(Key),
  skills: Schema.optional(
    Schema.Array(Key).check(
      Schema.isMaxLength(100),
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
  ),
  execution: Schema.optional(FactoryAgentExecution),
};
const OtherSteps = [
  Schema.Struct({ ...StepFields, kind: Schema.Literal("test"), checkId: Key }),
  Schema.Struct({ ...StepFields, kind: Schema.Literal("approval"), prompt: StepText }),
  Schema.Struct({
    ...StepFields,
    kind: Schema.Literal("publish"),
    target: Schema.Literal("pull_request"),
  }),
] as const;
const AutomationStep = Schema.Union([
  Schema.Struct({ ...AgentStepFields, resolved: Schema.optional(FactoryResolvedAgent) }),
  ...OtherSteps,
]);
const FactoryDefinitionStep = Schema.Union([Schema.Struct(AgentStepFields), ...OtherSteps]);
const sequential = Schema.makeFilter(
  (steps: ReadonlyArray<{ readonly id: string; readonly dependsOn: ReadonlyArray<string> }>) => {
    const seen = new Set<string>();
    for (const step of steps) {
      if (
        seen.has(step.id) ||
        new Set(step.dependsOn).size !== step.dependsOn.length ||
        step.dependsOn.some((id) => !seen.has(id))
      )
        return false;
      seen.add(step.id);
    }
    return true;
  },
  { message: "Sequential steps require unique IDs and dependencies on earlier steps only." },
);
const SequentialSteps = Schema.Array(AutomationStep).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  sequential,
);
export const FactoryDefinitionSteps = Schema.Array(FactoryDefinitionStep).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  sequential,
);
export const FactoryWorkflowExecution = Schema.Struct({
  mode: Schema.Literal("parallel"),
  maxParallelism: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  maxRepairRounds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  join: Schema.Literal("all_succeeded"),
  failurePolicy: Schema.Literal("repair_failed"),
  joinStepId: Key,
});

export const factoryWorkflowExecutionCheck = Schema.makeFilter(
  (workflow: {
    readonly steps: ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly dependsOn: ReadonlyArray<string>;
    }>;
    readonly execution?: typeof FactoryWorkflowExecution.Type | undefined;
  }) => {
    if (!workflow.execution) return true;
    if (workflow.steps.some((step) => step.dependsOn.length > 8)) return false;
    const joinIndex = workflow.steps.findIndex(
      (step) => step.id === workflow.execution!.joinStepId,
    );
    if (joinIndex < 2) return false;
    const join = workflow.steps[joinIndex]!;
    if (join.kind !== "agent" || join.dependsOn.length < 2) return false;
    const ancestors = new Set(join.dependsOn);
    for (let index = joinIndex - 1; index >= 0; index--) {
      const step = workflow.steps[index]!;
      if (step.kind !== "agent" || !ancestors.has(step.id)) return false;
      for (const dependency of step.dependsOn) ancestors.add(dependency);
    }
    for (let index = joinIndex + 1; index < workflow.steps.length; index++) {
      const step = workflow.steps[index]!;
      if (
        step.kind === "agent" ||
        step.dependsOn.length !== 1 ||
        step.dependsOn[0] !== workflow.steps[index - 1]!.id
      )
        return false;
    }
    return true;
  },
  {
    message:
      "Parallel workflows require agent branches converging on one explicit join, followed only by a serial test, approval or publish chain.",
  },
);
export const AutomationWorkflowVersion = Schema.Struct({
  id: Key,
  factoryId: Key,
  factoryVersionId: Key,
  steps: SequentialSteps,
  execution: Schema.optional(FactoryWorkflowExecution),
}).check(factoryWorkflowExecutionCheck);
export type AutomationWorkflowVersion = typeof AutomationWorkflowVersion.Type;
export const CreateAutomationWorkflowVersion = Schema.Struct({
  commandId: Key,
  ...AutomationWorkflowVersion.fields,
}).check(factoryWorkflowExecutionCheck);
export const AutomationRun = Schema.Struct({
  id: Key,
  factoryId: Key,
  workItemId: Key,
  workflowVersionId: Key,
  factoryVersionId: Key,
  repository: Key,
  revision: Key,
  state: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "paused",
    "cancel_requested",
    "cancelled",
    "failed",
    "succeeded",
  ]),
});
export type AutomationRun = typeof AutomationRun.Type;
export const StartAutomationRun = Schema.Struct({
  commandId: Key,
  id: Key,
  factoryId: Key,
  workItemId: Key,
  workflowVersionId: Key,
  revision: Key,
});
export const AutomationOutboxEntry = Schema.Struct({
  id: Key,
  runId: Key,
  kind: Schema.Literal("run.created"),
  payload: Schema.Struct({ runId: Key }),
});
export type AutomationOutboxEntry = typeof AutomationOutboxEntry.Type;
