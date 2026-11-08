import {
  AutomationApplicationQuery,
  AutomationApplicationCommand,
  AutomationControlCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { jsonSchema } from "./apiJsonSchema.ts";

export const Read = Schema.Union(
  AutomationApplicationQuery.members.filter((member) => {
    const isOp = Schema.is(member.fields.op);
    return [
      "factories",
      "factory",
      "workItems",
      "workItem",
      "runs",
      "run",
      "attempts",
      "attempt",
      "runtimeNode",
    ].some((op) => isOp(op));
  }),
);

export const Start = Schema.Union(
  AutomationApplicationCommand.members.filter((member) => {
    const op = member.fields.op;
    return Schema.is(op)("start") || Schema.is(op)("createWorkItem");
  }),
);

const descriptions = {
  foundry_query:
    "Discover allowed factories and their pinned workflows, work items, run status and attempt results. Paginate with next/after. Read the factory before starting a configured workflow or swarm. Handoff writes and plan operations are unavailable.",
  foundry_start:
    "Create a work item or start an existing versioned workflow, including configured swarms. Requires automation:start for this factory. Reuse the same commandId, run id and payload after uncertain delivery; changed payloads conflict. Read factory workflow versions first; supply the immutable revision and execution bindings required by the start schema.",
  foundry_control:
    "Control an existing run with its current expectedRevision and a stable commandId. Requires automation:control for this factory. Supports pause, resume, cancel, retry, answer and review decisions per schema. Read current run status before changing it. Handoff writes are unavailable.",
};
export const foundryMcpTools = [
  {
    name: "foundry_query",
    description: descriptions.foundry_query,
    inputSchema: { type: "object", ...jsonSchema(Read) },
  },
  {
    name: "foundry_start",
    description: descriptions.foundry_start,
    inputSchema: { type: "object", ...jsonSchema(Start) },
  },
  {
    name: "foundry_control",
    description: descriptions.foundry_control,
    inputSchema: { type: "object", ...jsonSchema(AutomationControlCommand) },
  },
];
