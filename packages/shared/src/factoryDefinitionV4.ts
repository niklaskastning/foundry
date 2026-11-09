import { stableStringify } from "./relaySigning.ts";
import {
  FactoryV4Manifest,
  FactoryV4Scorer,
  FactoryV4Agent,
  FactoryV4Mcp,
  FactoryV4Workflow,
  FactoryV4ResolvedAgent,
  type FactoryV4Snapshot,
  type FactoryV4Node,
  type FactoryV4File,
  type CanonicalFactoryDefinitionV4,
  type FactoryDefinitionFiles,
  type FactoryDefinitionIssue,
  type FactoryV4Condition,
  type FactoryV4ResultSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseDocument } from "yaml";

const FACTORY_V4_LIMITS = {
  files: 2048,
  fileBytes: 1024 * 1024,
  bundleBytes: 16 * 1024 * 1024,
  nodes: 1000,
  expandedNodes: 10000,
  depth: 4,
  conditionDepth: 16,
  resultDepth: 8,
} as const;
export function factoryFileBytes(file: {
  content: string;
  encoding?: "utf8" | "base64" | undefined;
}): Uint8Array {
  if (file.encoding !== "base64") return new TextEncoder().encode(file.content);
  const decoded = atob(file.content);
  if (btoa(decoded) !== file.content) throw new Error("Noncanonical base64");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
const factoryFileHash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export function parseFactoryYaml(content: string): unknown {
  const doc = parseDocument(content, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  let nodes = 0;
  const bound = (entry: unknown, depth: number) => {
    nodes++;
    if (depth > 64 || nodes > 100000) throw new Error("YAML structure limit");
    if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe key");
        bound(child, depth + 1);
      }
    }
  };
  bound(value, 0);
  return value;
}
const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const text = (file: FactoryV4File) =>
  new TextDecoder("utf-8", { fatal: true }).decode(factoryFileBytes(file));
const fail = (
  file: string,
  message: string,
): Result.Result<never, readonly FactoryDefinitionIssue[]> =>
  Result.fail([{ file, path: [], message }]);
export function validateFactoryV4Files(
  input: FactoryDefinitionFiles,
): Result.Result<CanonicalFactoryDefinitionV4, readonly FactoryDefinitionIssue[]> {
  let location = "factory.yaml";
  try {
    const files: FactoryV4File[] = [];
    let size = 0;
    const paths = new Set<string>();
    for (const file of input) {
      location = file.path;
      const bytes = factoryFileBytes(file);
      size += bytes.length;
      if (
        bytes.length > FACTORY_V4_LIMITS.fileBytes ||
        size > FACTORY_V4_LIMITS.bundleBytes ||
        input.length > FACTORY_V4_LIMITS.files
      )
        return fail(location, "Definition file or bundle exceeds its size limit.");
      if (paths.has(file.path) || paths.has(file.path.toLowerCase()))
        return fail(location, "Duplicate or case-colliding file path.");
      paths.add(file.path.toLowerCase());
      const hash = factoryFileHash(bytes);
      if (file.sha256 !== undefined && file.sha256 !== hash)
        return fail(location, "Content hash does not match pinned bytes.");
      let content = file.content;
      let encoding: "utf8" | "base64" = file.encoding ?? "utf8";
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        encoding = "utf8";
      } catch {}
      files.push({ path: file.path, content, encoding, mode: file.mode ?? "100644", sha256: hash });
    }
    for (const file of files) {
      const parts = file.path.toLowerCase().split("/");
      for (let index = 1; index < parts.length; index++)
        if (paths.has(parts.slice(0, index).join("/")))
          return fail(file.path, "File conflicts with a parent directory.");
    }
    const map = new Map(files.map((file) => [file.path, file]));
    const read = (path: string) => {
      location = path;
      const file = map.get(path);
      if (!file) throw new Error("Missing file");
      return text(file);
    };
    const manifest = decode(FactoryV4Manifest, parseFactoryYaml(read("factory.yaml")));
    const referenced = new Set(["factory.yaml"]);
    const registry = (items: readonly { id: string; file: string }[], directory: string) => {
      const ids = new Set<string>();
      for (const item of items) {
        if (ids.has(item.id) || item.file !== `${directory}/${item.id}.yaml`)
          throw new Error("Resource registration mismatch");
        ids.add(item.id);
        referenced.add(item.file);
      }
    };
    registry(manifest.workflows, "workflows");
    registry(manifest.agents, "agents");
    registry(manifest.mcp, "mcp");
    registry(manifest.scorers ?? [], "scorers");
    const scorers = manifest.scorers?.map((entry) => {
      const value = decode(FactoryV4Scorer, parseFactoryYaml(read(entry.file)));
      if (value.id !== entry.id) throw new Error("Scorer ID mismatch");
      return value;
    });
    if (new Set(manifest.repositories).size !== manifest.repositories.length)
      throw new Error("Duplicate repository");
    const agents = manifest.agents.map((entry) => {
      const value = decode(FactoryV4Agent, parseFactoryYaml(read(entry.file)));
      if (value.id !== entry.id) throw new Error("Resource ID mismatch");
      return value;
    });
    const mcp = manifest.mcp.map((entry) => {
      const value = decode(FactoryV4Mcp, parseFactoryYaml(read(entry.file)));
      if (value.id !== entry.id) throw new Error("Resource ID mismatch");
      return value;
    });
    const skills = manifest.skills.map((entry) => {
      location = entry.directory;
      if (
        entry.directory !== `skills/${entry.id}` ||
        entry.id.includes("--") ||
        entry.id.endsWith("-")
      )
        throw new Error("Invalid skill registration");
      const skillFiles = files
        .filter((file) => file.path.startsWith(`${entry.directory}/`))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (skillFiles.length > 512) throw new Error("Skill file limit");
      const markdown = read(`${entry.directory}/SKILL.md`);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
      if (!frontmatter) throw new Error("Missing skill frontmatter");
      const metadata = decode(
        Schema.Struct({
          name: Schema.String,
          description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
          license: Schema.optional(Schema.String),
          compatibility: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
          metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          "allowed-tools": Schema.optional(Schema.String),
        }),
        parseFactoryYaml(frontmatter[1]!),
      );
      if (metadata.name !== entry.id) throw new Error("Skill name mismatch");
      for (const file of skillFiles) referenced.add(file.path);
      return {
        id: entry.id,
        directory: entry.directory,
        name: metadata.name,
        description: metadata.description,
        files: skillFiles,
      };
    });
    if (new Set(skills.map((skill) => skill.id)).size !== skills.length)
      throw new Error("Duplicate skill");
    for (const file of files)
      if (!referenced.has(file.path)) return fail(file.path, "Unregistered resource file.");
    const workflows = manifest.workflows.map((entry) => {
      const value = decode(FactoryV4Workflow, parseFactoryYaml(read(entry.file)));
      if (value.id !== entry.id) throw new Error("Workflow ID mismatch");
      return value;
    });
    const definition: CanonicalFactoryDefinitionV4 = {
      schemaVersion: 4,
      ...(scorers ? { scorers } : {}),
      factoryId: manifest.factoryId,
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.triggers ? { triggers: manifest.triggers } : {}),
      repositories: [...manifest.repositories].sort(),
      agents,
      skills,
      mcp,
      workflows,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      ...(manifest.defaults ? { defaults: manifest.defaults } : {}),
    };
    if (
      new Set(manifest.triggers?.map((trigger) => trigger.id)).size !==
      (manifest.triggers?.length ?? 0)
    )
      throw new Error("Duplicate trigger ID");
    for (const trigger of manifest.triggers ?? []) {
      if (
        !manifest.repositories.includes(trigger.repository) ||
        !workflows.some((workflow) => workflow.id === trigger.workflow)
      )
        throw new Error("Invalid trigger reference");
      if (
        trigger.source.kind === "github_issue" &&
        trigger.source.repository !== trigger.repository
      )
        throw new Error("Trigger repository mismatch");
    }
    for (const agent of agents) assertResources(agent, definition);
    for (const workflow of workflows) {
      location = `workflows/${workflow.id}.yaml`;
      validateFactoryV4Graph(workflow.steps);
      assertResources(workflow.agentDefaults?.extend ?? {}, definition);
      const visit = (nodes: readonly FactoryV4Node[]) => {
        for (const node of nodes) {
          if (node.kind === "agent") {
            assertResources(node.extend ?? {}, definition);
            resolveFactoryV4Agent({ ...definition, workflow }, node);
          }
          if (node.kind === "swarm" || node.kind === "loop") visit(node.steps);
        }
      };
      visit(workflow.steps);
    }
    if (new TextEncoder().encode(stableStringify(definition)).byteLength > 32 * 1024 * 1024)
      return fail("factory.yaml", "Encoded snapshot exceeds its size limit.");
    return Result.succeed(definition);
  } catch {
    return fail(location, "Invalid v4 resource, graph, reference or bounded schema.");
  }
}
function assertResources(
  value: {
    readonly skills?: readonly string[] | undefined;
    readonly mcp?: readonly string[] | undefined;
  },
  definition: Pick<CanonicalFactoryDefinitionV4, "skills" | "mcp">,
) {
  for (const id of value.skills ?? [])
    if (!definition.skills.some((item) => item.id === id)) throw new Error("Missing skill");
  for (const id of value.mcp ?? [])
    if (!definition.mcp.some((item) => item.id === id)) throw new Error("Missing MCP");
}
export function resolveFactoryV4Agent(
  snapshot: FactoryV4Snapshot,
  node: Extract<FactoryV4Node, { kind: "agent" }>,
): FactoryV4ResolvedAgent {
  const agent = snapshot.agents.find((item) => item.id === node.agent);
  if (!agent) throw new Error("Missing agent");
  const workflow = snapshot.workflow.agentDefaults;
  const instructions = [
    { source: "agent" as const, value: agent.instructions },
    ...(workflow?.extend?.instructions
      ? [{ source: "workflow" as const, value: workflow.extend.instructions }]
      : []),
    ...(node.extend?.instructions
      ? [{ source: "step" as const, value: node.extend.instructions }]
      : []),
    { source: "step" as const, value: node.instructions },
  ];
  const layers = [
    { source: "agent" as const, value: agent },
    { source: "workflow" as const, value: workflow?.extend },
    { source: "step" as const, value: node.extend },
  ];
  const resources = (kind: "skills" | "mcp") => {
    const entries = new Map<string, Array<"agent" | "workflow" | "step">>();
    for (const layer of layers)
      for (const id of layer.value?.[kind] ?? []) {
        const sources = entries.get(id) ?? [];
        if (!sources.includes(layer.source)) sources.push(layer.source);
        entries.set(id, sources);
      }
    return [...entries].map(([id, sources]) => ({ id, sources }));
  };
  const skillSources = resources("skills");
  const mcpSources = resources("mcp");
  const executionLayers = [
    { source: "factory" as const, value: snapshot.defaults?.execution },
    { source: "agent" as const, value: agent.execution },
    { source: "workflow" as const, value: workflow?.execution },
    { source: "step" as const, value: node.execution },
  ];
  const provider = executionLayers.findLast((layer) => layer.value?.provider !== undefined);
  const model = executionLayers.findLast((layer) => layer.value?.model !== undefined);
  const reasoning = executionLayers.findLast(
    (layer) => layer.value?.options?.reasoningEffort !== undefined,
  );
  return decode(FactoryV4ResolvedAgent, {
    agent: { id: agent.id, name: agent.name },
    instructions: instructions.map((item) => item.value).join("\n\n"),
    skills: skillSources.map(({ id }) => {
      const skill = snapshot.skills.find((item) => item.id === id);
      if (!skill) throw new Error("Missing skill");
      return skill;
    }),
    mcp: mcpSources.map(({ id }) => {
      const value = snapshot.mcp.find((item) => item.id === id);
      if (!value) throw new Error("Missing MCP");
      return value;
    }),
    execution: {
      provider: "codex",
      ...(model ? { model: model.value!.model } : {}),
      ...(reasoning
        ? { options: { reasoningEffort: reasoning.value!.options!.reasoningEffort } }
        : {}),
    },
    provenance: {
      instructions,
      skills: skillSources,
      mcp: mcpSources,
      execution: {
        provider: provider?.source ?? "factory",
        ...(model ? { model: model.source } : {}),
        ...(reasoning ? { reasoningEffort: reasoning.source } : {}),
      },
    },
  });
}
function validateFactoryV4Graph(roots: readonly FactoryV4Node[]): void {
  let count = 0;
  let expanded = 0;
  const scope = (
    nodes: readonly FactoryV4Node[],
    depth: number,
    inLoop: boolean,
    multiplier: number,
  ) => {
    if (depth > FACTORY_V4_LIMITS.depth) throw new Error("Container depth");
    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.size !== nodes.length) throw new Error("Duplicate node");
    const complete = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Cycle");
      if (complete.has(id)) return;
      const node = byId.get(id);
      if (!node) throw new Error("Missing dependency");
      visiting.add(id);
      for (const dependency of node.dependsOn) visit(dependency);
      visiting.delete(id);
      complete.add(id);
    };
    for (const node of nodes) visit(node.id);
    const ancestry = (node: FactoryV4Node): Set<string> => {
      const result = new Set<string>();
      const walk = (id: string) => {
        if (result.has(id)) return;
        result.add(id);
        for (const next of byId.get(id)!.dependsOn) walk(next);
      };
      for (const id of node.dependsOn) walk(id);
      return result;
    };
    const checkRef = (reference: string, allowed: Set<string>, body = false) => {
      const parts = reference.split(".");
      if (parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part)))
        throw new Error("Unsafe reference");
      if (parts[0] === "inputs" && parts.length >= 2) return;
      if (parts[0] === "iteration" && parts.length === 1 && inLoop) return;
      if (parts[0] === "carry" && parts.length >= 2 && inLoop) return;
      if (
        parts[0] === "previous" &&
        parts[1] === "steps" &&
        parts.length >= 4 &&
        inLoop &&
        byId.has(parts[2]!) &&
        ["status", "output", "artifacts"].includes(parts[3]!)
      )
        return;
      if (
        parts[0] === "steps" &&
        parts.length >= 3 &&
        allowed.has(parts[1]!) &&
        ["status", "output", "artifacts"].includes(parts[2]!)
      ) {
        if (parts[2] === "artifacts" && (parts[3] !== "checkpoint" || parts.length !== 4))
          throw new Error("Unknown artifact");
        return;
      }
      if (body && parts[0] === "iteration" && parts.length === 1) return;
      throw new Error("Unavailable reference");
    };
    const condition = (value: FactoryV4Condition, allowed: Set<string>, level = 0) => {
      if (level > 16) throw new Error("Condition depth");
      if ("eq" in value || "ne" in value) {
        for (const operand of "eq" in value ? value.eq : value.ne)
          if ("ref" in operand) checkRef(operand.ref, allowed);
      } else if ("all" in value || "any" in value) {
        for (const child of "all" in value ? value.all : value.any)
          condition(child, allowed, level + 1);
      } else if ("not" in value) condition(value.not, allowed, level + 1);
      else checkRef(value.exists.ref, allowed);
    };
    for (const node of nodes) {
      count++;
      expanded += multiplier;
      if (count > 1000 || expanded > 10000) throw new Error("Expanded node limit");
      if (new Set(node.dependsOn).size !== node.dependsOn.length)
        throw new Error("Duplicate dependency");
      const ancestors = ancestry(node);
      if (node.when) condition(node.when, ancestors);
      if (node.kind === "agent") {
        for (const operand of Object.values(node.inputs ?? {}))
          if ("ref" in operand) checkRef(operand.ref, ancestors);
        if (node.resultSchema) validateFactoryV4ResultSchema(node.resultSchema);
      }
      if (node.kind === "agent" || node.kind === "test") {
        if (node.workspace?.from) {
          checkRef(node.workspace.from.ref, ancestors);
          const parts = node.workspace.from.ref.split(".");
          let source = parts[0] === "steps" ? byId.get(parts[1]!) : undefined;
          let offset = 2;
          while (source && parts[offset] === "output") {
            const collection =
              source.kind === "swarm" ? "members" : source.kind === "loop" ? "last" : null;
            if (
              !collection ||
              parts[offset + 1] !== collection ||
              (source.kind !== "swarm" && source.kind !== "loop")
            )
              throw new Error("Workspace requires checkpoint");
            source = source.steps.find((child) => child.id === parts[offset + 2]);
            offset += 3;
          }
          if (
            !source ||
            source.kind === "swarm" ||
            parts[offset] !== "artifacts" ||
            parts[offset + 1] !== "checkpoint" ||
            parts.length !== offset + 2
          )
            throw new Error("Workspace requires checkpoint");
        }
      }
      if (node.kind === "publish") {
        if (depth !== 0 || nodes.some((other) => other.dependsOn.includes(node.id)))
          throw new Error("Publish must terminate root scope");
        if (![...ancestors].some((id) => byId.get(id)?.kind === "test"))
          throw new Error("Publish requires tested checkpoint");
      }
      if (node.kind === "swarm") {
        if (node.join.policy === "quorum" && node.join.minSuccesses > node.steps.length)
          throw new Error("Impossible quorum");
        scope(node.steps, depth + 1, inLoop, multiplier);
      }
      if (node.kind === "loop") {
        for (const operand of Object.values(node.carry ?? {}))
          if ("ref" in operand) checkRef(operand.ref, ancestors);
        const bodyIds = new Set(node.steps.map((step) => step.id));
        const checkBodyRef = (ref: string) => {
          if (ref.startsWith("carry.") || ref === "iteration" || ref.startsWith("previous.steps."))
            return;
          checkRef(ref, bodyIds, true);
        };
        const walkCondition = (value: FactoryV4Condition, level = 0) => {
          if (level > 16) throw new Error("Condition depth");
          if ("eq" in value || "ne" in value) {
            for (const operand of "eq" in value ? value.eq : value.ne)
              if ("ref" in operand) checkBodyRef(operand.ref);
          } else if ("all" in value || "any" in value) {
            for (const child of "all" in value ? value.all : value.any)
              walkCondition(child, level + 1);
          } else if ("not" in value) walkCondition(value.not, level + 1);
          else checkBodyRef(value.exists.ref);
        };
        walkCondition(node.until);
        for (const operand of Object.values(node.nextCarry ?? {}))
          if ("ref" in operand) checkBodyRef(operand.ref);
        const writers = node.steps.filter(
          (step) => step.kind === "agent" && step.workspace?.access === "write",
        );
        const nestedWriter = (children: readonly FactoryV4Node[]): boolean =>
          children.some(
            (step) =>
              (step.kind === "agent" && step.workspace?.access === "write") ||
              ((step.kind === "loop" || step.kind === "swarm") && nestedWriter(step.steps)),
          );
        if (node.workspaceFrom) {
          if (!writers.some((step) => step.id === node.workspaceFrom))
            throw new Error("Invalid integration checkpoint");
        } else if (
          writers.length > 1 ||
          node.steps.some(
            (step) => (step.kind === "swarm" || step.kind === "loop") && nestedWriter(step.steps),
          )
        )
          throw new Error("Ambiguous loop workspace");
        scope(node.steps, depth + 1, true, multiplier * node.maxIterations);
      }
    }
  };
  scope(roots, 0, false, 1);
}
function validateFactoryV4ResultSchema(schema: FactoryV4ResultSchema, depth = 0): void {
  if (depth > 8) throw new Error("Result schema depth");
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new Error("Closed objects required");
    const names = Object.keys(schema.properties ?? {});
    if (
      names.length > 100 ||
      names.some((key) => ["__proto__", "constructor", "prototype"].includes(key)) ||
      schema.required?.some((key) => !names.includes(key)) ||
      new Set(schema.required).size !== (schema.required?.length ?? 0)
    )
      throw new Error("Invalid object schema");
    for (const child of Object.values(schema.properties ?? {}))
      validateFactoryV4ResultSchema(child, depth + 1);
  } else if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  )
    throw new Error("Object keywords");
  if (schema.type === "array") {
    if (!schema.items || schema.maxItems === undefined) throw new Error("Bounded arrays required");
    validateFactoryV4ResultSchema(schema.items, depth + 1);
  } else if (schema.items !== undefined || schema.maxItems !== undefined)
    throw new Error("Array keywords");
  if (schema.maxLength !== undefined && schema.type !== "string") throw new Error("String keyword");
}
