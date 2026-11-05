import * as Schema from "effect/Schema";
import { FactoryAgentExecution } from "./agentExecution.ts";

export const FactoryV4Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Ids = Schema.Array(FactoryV4Id).check(Schema.isMaxLength(100));
export const FactoryV4Path = Schema.String.check(
  Schema.isMaxLength(240),
  Schema.isPattern(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
  Schema.makeFilter((path) => path.split("/").every((part) => part !== "." && part !== "..")),
);
export const FactoryV4File = Schema.Struct({
  path: FactoryV4Path,
  content: Schema.String.check(Schema.isMaxLength(1_398_104)),
  encoding: Schema.Literals(["utf8", "base64"]),
  mode: Schema.Literals(["100644", "100755"]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type FactoryV4File = typeof FactoryV4File.Type;
export const FactoryV4Extend = Schema.Struct({
  instructions: Schema.optional(Text),
  skills: Schema.optional(Ids),
  mcp: Schema.optional(Ids),
});
export const FactoryV4Agent = Schema.Struct({
  id: FactoryV4Id,
  name: Name,
  description: Name,
  instructions: Text,
  skills: Ids,
  mcp: Ids,
  execution: Schema.optional(FactoryAgentExecution),
});
export type FactoryV4Agent = typeof FactoryV4Agent.Type;
const ToolNames = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
).check(
  Schema.isMaxLength(100),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length),
);
const McpFields = { id: FactoryV4Id, name: Name, allowedTools: ToolNames };
const Environment = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)),
  Schema.String.check(Schema.isMaxLength(2000)),
);
export const FactoryV4Mcp = Schema.Union([
  Schema.Struct({
    ...McpFields,
    transport: Schema.Literal("stdio"),
    command: Name,
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(2000))).check(
      Schema.isMaxLength(100),
    ),
    env: Schema.optional(Environment),
    secretEnv: Schema.optional(Environment),
  }),
  Schema.Struct({
    ...McpFields,
    transport: Schema.Literal("streamable-http"),
    url: Schema.String.check(
      Schema.isMaxLength(2000),
      Schema.makeFilter((value) => {
        try {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    ),
    auth: Schema.optional(Schema.Struct({ connection: FactoryV4Id })),
  }),
]);
export type FactoryV4Mcp = typeof FactoryV4Mcp.Type;
export const FactoryV4Skill = Schema.Struct({
  id: FactoryV4Id,
  directory: FactoryV4Path,
  name: Name,
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  files: Schema.Array(FactoryV4File).check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type FactoryV4Skill = typeof FactoryV4Skill.Type;
export const FactoryV4Operand = Schema.Union([
  Schema.Struct({ ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)) }),
  Schema.Struct({ value: Schema.Json }),
]);
export type FactoryV4Operand = typeof FactoryV4Operand.Type;
export type FactoryV4Condition =
  | { readonly eq: readonly [FactoryV4Operand, FactoryV4Operand] }
  | { readonly ne: readonly [FactoryV4Operand, FactoryV4Operand] }
  | { readonly all: readonly FactoryV4Condition[] }
  | { readonly any: readonly FactoryV4Condition[] }
  | { readonly not: FactoryV4Condition }
  | { readonly exists: { readonly ref: string } };
const ConditionRef = Schema.suspend((): Schema.Codec<FactoryV4Condition> => FactoryV4Condition);
export const FactoryV4Condition = Schema.Union([
  Schema.Struct({ eq: Schema.Tuple([FactoryV4Operand, FactoryV4Operand]) }),
  Schema.Struct({ ne: Schema.Tuple([FactoryV4Operand, FactoryV4Operand]) }),
  Schema.Struct({
    all: Schema.Array(ConditionRef).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    any: Schema.Array(ConditionRef).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
  Schema.Struct({ not: ConditionRef }),
  Schema.Struct({ exists: Schema.Struct({ ref: Schema.String.check(Schema.isMaxLength(500)) }) }),
]);
export type FactoryV4ResultSchema = {
  readonly type: "object" | "array" | "string" | "boolean" | "integer" | "number" | "null";
  readonly properties?: Readonly<Record<string, FactoryV4ResultSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: false | undefined;
  readonly items?: FactoryV4ResultSchema | undefined;
  readonly enum?: readonly Schema.Json[] | undefined;
  readonly maxItems?: number | undefined;
  readonly maxLength?: number | undefined;
};
const ResultRef = Schema.suspend((): Schema.Codec<FactoryV4ResultSchema> => FactoryV4ResultSchema);
export const FactoryV4ResultSchema = Schema.Struct({
  type: Schema.Literals(["object", "array", "string", "boolean", "integer", "number", "null"]),
  properties: Schema.optional(Schema.Record(Schema.String, ResultRef)),
  required: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
  additionalProperties: Schema.optional(Schema.Literal(false)),
  items: Schema.optional(ResultRef),
  enum: Schema.optional(
    Schema.Array(Schema.Json).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  maxItems: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
  maxLength: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65536 }))),
});
const Inputs = Schema.Record(FactoryV4Id, FactoryV4Operand);
const Workspace = Schema.Struct({
  access: Schema.Literals(["read", "write"]),
  from: Schema.optional(Schema.Struct({ ref: Schema.String.check(Schema.isMaxLength(500)) })),
});
const Common = {
  id: FactoryV4Id,
  dependsOn: Ids,
  when: Schema.optional(FactoryV4Condition),
  dependencyPolicy: Schema.optional(Schema.Literal("terminal")),
};
const Executable = {
  retry: Schema.optional(
    Schema.Struct({ maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })) }),
  ),
};
export const FactoryV4AgentNode = Schema.Struct({
  ...Common,
  ...Executable,
  kind: Schema.Literal("agent"),
  agent: FactoryV4Id,
  instructions: Text,
  extend: Schema.optional(FactoryV4Extend),
  execution: Schema.optional(FactoryAgentExecution),
  inputs: Schema.optional(Inputs),
  workspace: Schema.optional(Workspace),
  resultSchema: Schema.optional(FactoryV4ResultSchema),
});
const TestNode = Schema.Struct({
  ...Common,
  ...Executable,
  kind: Schema.Literal("test"),
  checkId: Name,
  workspace: Schema.optional(Workspace),
});
const ApprovalNode = Schema.Struct({
  ...Common,
  kind: Schema.Literal("approval"),
  instructions: Text,
});
const PublishNode = Schema.Struct({
  ...Common,
  kind: Schema.Literal("publish"),
  target: Schema.Literal("pull_request"),
});
type CommonNode = {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly when?: FactoryV4Condition | undefined;
  readonly dependencyPolicy?: "terminal" | undefined;
};
export type FactoryV4Node =
  | typeof FactoryV4AgentNode.Type
  | typeof TestNode.Type
  | typeof ApprovalNode.Type
  | typeof PublishNode.Type
  | (CommonNode & {
      readonly kind: "swarm";
      readonly maxParallel: number;
      readonly join:
        | { readonly policy: "all"; readonly onFailure: "collect" | "cancel_remaining" }
        | {
            readonly policy: "quorum";
            readonly minSuccesses: number;
            readonly onFailure: "collect" | "cancel_remaining";
          };
      readonly steps: readonly FactoryV4Node[];
    })
  | (CommonNode & {
      readonly kind: "loop";
      readonly maxIterations: number;
      readonly steps: readonly FactoryV4Node[];
      readonly until: FactoryV4Condition;
      readonly onExhausted: "fail" | "approval";
      readonly carry?: Readonly<Record<string, FactoryV4Operand>> | undefined;
      readonly nextCarry?: Readonly<Record<string, FactoryV4Operand>> | undefined;
      readonly workspaceFrom?: string | undefined;
    });
const NodeRef = Schema.suspend((): Schema.Codec<FactoryV4Node> => FactoryV4Node);
const Nodes = Schema.Array(NodeRef).check(Schema.isMinLength(1), Schema.isMaxLength(100));
export const FactoryV4Node = Schema.Union([
  FactoryV4AgentNode,
  TestNode,
  ApprovalNode,
  PublishNode,
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("swarm"),
    maxParallel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    join: Schema.Union([
      Schema.Struct({
        policy: Schema.Literal("all"),
        onFailure: Schema.Literals(["collect", "cancel_remaining"]),
      }),
      Schema.Struct({
        policy: Schema.Literal("quorum"),
        minSuccesses: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
        onFailure: Schema.Literals(["collect", "cancel_remaining"]),
      }),
    ]),
    steps: Nodes,
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("loop"),
    maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    steps: Nodes,
    until: FactoryV4Condition,
    onExhausted: Schema.Literals(["fail", "approval"]),
    carry: Schema.optional(Inputs),
    nextCarry: Schema.optional(Inputs),
    workspaceFrom: Schema.optional(FactoryV4Id),
  }),
]);
export const FactoryV4Workflow = Schema.Struct({
  id: FactoryV4Id,
  agentDefaults: Schema.optional(
    Schema.Struct({
      extend: Schema.optional(FactoryV4Extend),
      execution: Schema.optional(FactoryAgentExecution),
    }),
  ),
  limits: Schema.Struct({
    maxConcurrentAgents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    maxAgentExecutions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  }),
  steps: Nodes,
});
export type FactoryV4Workflow = typeof FactoryV4Workflow.Type;
const Registration = Schema.Struct({ id: FactoryV4Id, file: FactoryV4Path });
export const FactoryV4Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  factoryId: Name,
  repositories: Schema.Array(Name).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  workflows: Schema.Array(Registration).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  agents: Schema.Array(Registration).check(Schema.isMaxLength(100)),
  skills: Schema.Array(Schema.Struct({ id: FactoryV4Id, directory: FactoryV4Path })).check(
    Schema.isMaxLength(100),
  ),
  mcp: Schema.Array(Registration).check(Schema.isMaxLength(100)),
  defaults: Schema.optional(Schema.Struct({ execution: FactoryAgentExecution })),
});
export const CanonicalFactoryDefinitionV4 = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  factoryId: Name,
  repositories: Schema.Array(Name),
  workflows: Schema.Array(FactoryV4Workflow),
  agents: Schema.Array(FactoryV4Agent),
  skills: Schema.Array(FactoryV4Skill),
  mcp: Schema.Array(FactoryV4Mcp),
  defaults: FactoryV4Manifest.fields.defaults,
  files: Schema.Array(FactoryV4File).check(Schema.isMaxLength(2048)),
});
export type CanonicalFactoryDefinitionV4 = typeof CanonicalFactoryDefinitionV4.Type;
export const FactoryV4Snapshot = Schema.Struct({
  workflow: FactoryV4Workflow,
  agents: Schema.Array(FactoryV4Agent),
  skills: Schema.Array(FactoryV4Skill),
  mcp: Schema.Array(FactoryV4Mcp),
  files: Schema.Array(FactoryV4File),
  defaults: FactoryV4Manifest.fields.defaults,
});
export type FactoryV4Snapshot = typeof FactoryV4Snapshot.Type;
const Source = Schema.Literals(["factory", "agent", "workflow", "step"]);
const ResourceProvenance = Schema.Array(
  Schema.Struct({ id: FactoryV4Id, sources: Schema.Array(Source) }),
);
export const FactoryV4ResolvedAgent = Schema.Struct({
  agent: Schema.Struct({ id: FactoryV4Id, name: Name }),
  instructions: Schema.String.check(Schema.isMaxLength(80000)),
  skills: Schema.Array(FactoryV4Skill),
  mcp: Schema.Array(FactoryV4Mcp),
  execution: Schema.Struct({ ...FactoryAgentExecution.fields, provider: Schema.Literal("codex") }),
  provenance: Schema.Struct({
    instructions: Schema.Array(Schema.Struct({ source: Source, value: Text })),
    skills: ResourceProvenance,
    mcp: ResourceProvenance,
    execution: Schema.Struct({
      provider: Source,
      model: Schema.optional(Source),
      reasoningEffort: Schema.optional(Source),
    }),
  }),
});
export type FactoryV4ResolvedAgent = typeof FactoryV4ResolvedAgent.Type;
