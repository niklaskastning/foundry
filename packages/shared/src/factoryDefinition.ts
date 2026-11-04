import {
  type CanonicalFactoryDefinition,
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
    message: issue.message,
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
    schemaVersion: 1,
    factoryId: manifest.success.factoryId,
    repositories: [...manifest.success.repositories].sort(),
    workflows: workflows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  } satisfies CanonicalFactoryDefinition;
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
        schemaVersion: 1,
        factoryId: definition.factoryId,
        repositories: definition.repositories,
        workflows,
      }),
    },
    ...definition.workflows.map((workflow) => ({
      path: `workflows/${workflow.id}.yaml`,
      content: stringify({ steps: workflow.steps }),
    })),
  ];
}
