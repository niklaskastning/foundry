import {
  type CanonicalFactoryDefinition,
  type AutomationWorkflowVersion,
  FactoryResolvedAgent,
  type FactoryDefinitionIssue,
  FactoryDefinitionFiles,
  FactoryDefinitionManifest,
  FactoryWorkflowFile,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { parseDocument, stringify } from "yaml";
import { stableStringify } from "./relaySigning.ts";

const decodeFiles = Schema.decodeResult(FactoryDefinitionFiles, { onExcessProperty: "error" });
const decodeManifest = Schema.decodeUnknownResult(FactoryDefinitionManifest, {
  onExcessProperty: "error",
  errors: "all",
});
const decodeWorkflow = Schema.decodeUnknownResult(FactoryWorkflowFile, {
  onExcessProperty: "error",
  errors: "all",
});

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey"
      ? "Required field is missing."
      : issue._tag === "UnexpectedKey"
        ? "Unsupported field."
        : "Invalid field value.",
  checkHook: () => "Invalid definition constraints.",
});
const schemaIssues = (
  file: string,
  error: Schema.SchemaError,
): ReadonlyArray<FactoryDefinitionIssue> =>
  formatIssues(error.issue).issues.map((issue) => ({
    file,
    path: (issue.path ?? []).map((part) =>
      typeof part === "object" ? String(part.key) : typeof part === "number" ? part : String(part),
    ),
    message:
      issue.path?.at(-1) === "provider"
        ? "Only the Codex provider is supported by Factory workers."
        : issue.message,
  }));
const parse = <A>(
  file: string,
  content: string,
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
): Result.Result<A, ReadonlyArray<FactoryDefinitionIssue>> => {
  try {
    const document = parseDocument(content, {
      schema: "core",
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
    });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem)
      return Result.fail([{ file, path: [], message: `Invalid YAML (${problem.code}).` }]);
    const decoded = decode(document.toJS({ maxAliasCount: 0 }));
    return Result.mapError(decoded, (error) => schemaIssues(file, error));
  } catch {
    return Result.fail([{ file, path: [], message: "Unsupported YAML structure or aliases." }]);
  }
};
export function validateFactoryFiles(
  files: FactoryDefinitionFiles,
): Result.Result<CanonicalFactoryDefinition, ReadonlyArray<FactoryDefinitionIssue>> {
  const bundle = decodeFiles(files);
  if (Result.isFailure(bundle)) return Result.fail(schemaIssues("factory.yaml", bundle.failure));
  const contents = new Map<string, string>();
  let size = 0;
  for (const file of bundle.success) {
    const bytes = new TextEncoder().encode(file.content).byteLength;
    size += bytes;
    if (bytes > 256 * 1024 || size > 2 * 1024 * 1024)
      return Result.fail([
        { file: file.path, path: [], message: "Definition file or bundle exceeds its size limit." },
      ]);
    if (contents.has(file.path))
      return Result.fail([{ file: file.path, path: [], message: "Duplicate file path." }]);
    contents.set(file.path, file.content);
  }
  const entry = contents.get("factory.yaml");
  if (entry === undefined)
    return Result.fail([{ file: "factory.yaml", path: [], message: "Missing entry file." }]);
  const manifest = parse("factory.yaml", entry, decodeManifest);
  if (Result.isFailure(manifest)) return Result.fail(manifest.failure);
  if (
    manifest.success.schemaVersion === 1 &&
    (manifest.success.roles !== undefined ||
      manifest.success.skills !== undefined ||
      manifest.success.defaults !== undefined)
  )
    return Result.fail([
      {
        file: "factory.yaml",
        path: ["schemaVersion"],
        message: "Roles, skills and execution defaults require schemaVersion 2.",
      },
    ]);
  const workflows: Array<CanonicalFactoryDefinition["workflows"][number]> = [];
  const referenced = new Set(["factory.yaml"]);
  for (const [index, workflow] of manifest.success.workflows.entries()) {
    const content = contents.get(workflow.file);
    if (content === undefined)
      return Result.fail([
        {
          file: "factory.yaml",
          path: ["workflows", index, "file"],
          message: "Referenced workflow file is missing.",
        },
      ]);
    referenced.add(workflow.file);
    const decoded = parse(workflow.file, content, decodeWorkflow);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    const steps = decoded.success.steps;
    if (decoded.success.execution !== undefined && manifest.success.schemaVersion !== 3)
      return Result.fail([
        {
          file: workflow.file,
          path: ["execution"],
          message: "Parallel execution requires schemaVersion 3.",
        },
      ]);
    if (
      manifest.success.schemaVersion === 1 &&
      steps.some(
        (step) =>
          step.kind === "agent" &&
          (step.role !== undefined || step.skills !== undefined || step.execution !== undefined),
      )
    )
      return Result.fail([
        {
          file: workflow.file,
          path: ["steps"],
          message: "Agent roles, skills and execution settings require schemaVersion 2.",
        },
      ]);
    const publishIndex = steps.findIndex((step) => step.kind === "publish");
    if (
      publishIndex >= 0 &&
      (publishIndex !== steps.length - 1 ||
        steps.findLast((step) => step.kind === "agent" || step.kind === "test")?.kind !== "test")
    )
      return Result.fail([
        {
          file: workflow.file,
          path: ["steps"],
          message:
            "Publishing requires one final publish step after a test; only approval steps may follow that test.",
        },
      ]);
    workflows.push({
      id: workflow.id,
      ...(decoded.success.execution ? { execution: decoded.success.execution } : {}),
      steps: steps.map((step) => ({
        ...step,
        dependsOn: [...step.dependsOn].sort(),
      })),
    });
  }
  for (const file of contents.keys())
    if (!referenced.has(file))
      return Result.fail([
        { file, path: [], message: "Unreferenced or unsupported resource file." },
      ]);
  const definition = {
    schemaVersion: manifest.success.schemaVersion,
    ...(manifest.success.roles === undefined
      ? {}
      : { roles: [...manifest.success.roles].sort(byId) }),
    ...(manifest.success.skills === undefined
      ? {}
      : { skills: [...manifest.success.skills].sort(byId) }),
    ...(manifest.success.defaults === undefined ? {} : { defaults: manifest.success.defaults }),
    factoryId: manifest.success.factoryId,
    repositories: [...manifest.success.repositories].sort(),
    workflows: workflows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  } satisfies CanonicalFactoryDefinition;
  const knownSkills = new Set(definition.skills?.map((skill) => skill.id));
  for (const [index, role] of (manifest.success.roles ?? []).entries()) {
    if (role.skills.some((id) => !knownSkills.has(id)))
      return Result.fail([
        {
          file: "factory.yaml",
          path: ["roles", index, "skills"],
          message: "Referenced skill is missing from the versioned skill catalog.",
        },
      ]);
  }
  let resolvedSize = 0;
  for (const workflow of definition.workflows) {
    for (const [index, step] of workflow.steps.entries()) {
      if (step.kind !== "agent") continue;
      const file = manifest.success.workflows.find((entry) => entry.id === workflow.id)!.file;
      if (step.role !== undefined && !definition.roles?.some((role) => role.id === step.role))
        return Result.fail([
          {
            file,
            path: ["steps", index, "role"],
            message: "Referenced role is missing from the versioned role catalog.",
          },
        ]);
      if (step.skills?.some((id) => !knownSkills.has(id)))
        return Result.fail([
          {
            file,
            path: ["steps", index, "skills"],
            message: "Referenced skill is missing from the versioned skill catalog.",
          },
        ]);
    }
    try {
      resolvedSize += new TextEncoder().encode(
        JSON.stringify(resolveFactoryWorkflow(definition, workflow.id)),
      ).byteLength;
      if (resolvedSize > 2 * 1024 * 1024)
        return Result.fail([
          {
            file: "factory.yaml",
            path: ["workflows"],
            message: "Resolved workflow snapshots exceed the definition size limit.",
          },
        ]);
    } catch {
      return Result.fail([
        {
          file: manifest.success.workflows.find((entry) => entry.id === workflow.id)!.file,
          path: ["steps"],
          message: "Resolved agent instructions or resource count exceed supported limits.",
        },
      ]);
    }
  }
  let exportedSize = 0;
  for (const file of exportFactoryFiles(definition)) {
    const bytes = new TextEncoder().encode(file.content).byteLength;
    exportedSize += bytes;
    if (bytes > 256 * 1024 || exportedSize > 2 * 1024 * 1024)
      return Result.fail([
        {
          file:
            manifest.success.workflows.find(
              (workflow) => `workflows/${workflow.id}.yaml` === file.path,
            )?.file ?? file.path,
          path: [],
          message: "Canonical export exceeds the definition size limit.",
        },
      ]);
  }
  return Result.succeed(definition);
}

export function canonicalFactoryJson(definition: CanonicalFactoryDefinition): string {
  return stableStringify(definition);
}

export function exportFactoryFiles(definition: CanonicalFactoryDefinition): FactoryDefinitionFiles {
  const workflows = definition.workflows.map((workflow) => ({
    id: workflow.id,
    file: `workflows/${workflow.id}.yaml`,
  }));
  return [
    {
      path: "factory.yaml",
      content: stringify({
        schemaVersion: definition.schemaVersion,
        ...(definition.roles === undefined ? {} : { roles: definition.roles }),
        ...(definition.skills === undefined ? {} : { skills: definition.skills }),
        ...(definition.defaults === undefined ? {} : { defaults: definition.defaults }),
        factoryId: definition.factoryId,
        repositories: definition.repositories,
        workflows,
      }),
    },
    ...definition.workflows.map((workflow) => ({
      path: `workflows/${workflow.id}.yaml`,
      content: stringify({
        steps: workflow.steps,
        ...(workflow.execution ? { execution: workflow.execution } : {}),
      }),
    })),
  ];
}

const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const decodeResolved = Schema.decodeUnknownSync(FactoryResolvedAgent, {
  onExcessProperty: "error",
});

export function resolveFactoryWorkflow(
  definition: CanonicalFactoryDefinition,
  workflowId: string,
): AutomationWorkflowVersion["steps"] {
  const workflow = definition.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) throw new Error("Workflow is missing from the definition.");
  if (definition.schemaVersion === 1) return workflow.steps;
  return workflow.steps.map((step) => {
    if (step.kind !== "agent") return step;
    const role = definition.roles?.find((entry) => entry.id === step.role);
    if (step.role !== undefined && !role) throw new Error("Referenced role is missing.");
    const skillIds = [...new Set([...(role?.skills ?? []), ...(step.skills ?? [])])];
    const skills = skillIds.map((id) => {
      const skill = definition.skills?.find((entry) => entry.id === id);
      if (!skill) throw new Error("Referenced skill is missing.");
      return skill;
    });
    const layers = [definition.defaults, role?.execution, step.execution];
    const model = layers.findLast((layer) => layer?.model !== undefined)?.model;
    const reasoningEffort = layers.findLast(
      (layer) => layer?.options?.reasoningEffort !== undefined,
    )?.options?.reasoningEffort;
    const resolved = decodeResolved({
      ...(role ? { role: { id: role.id, name: role.name, instructions: role.instructions } } : {}),
      skills,
      execution: {
        provider: "codex",
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { options: { reasoningEffort } }),
      },
      instructions: [
        role?.instructions,
        ...skills.map((skill) => `Skill: ${skill.name} (${skill.id})\n${skill.instructions}`),
      ]
        .filter((text) => text !== undefined)
        .join("\n\n"),
    });
    return { ...step, resolved };
  });
}
