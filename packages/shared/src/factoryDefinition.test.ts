import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import {
  canonicalFactoryJson,
  exportFactoryFiles,
  validateFactoryFiles,
} from "./factoryDefinition.ts";

const files = () => [
  {
    path: "factory.yaml",
    content:
      "schemaVersion: 1\nfactoryId: a\nrepositories: [repo-z, repo-a]\nworkflows: [{id: main, file: custom/build.yaml}]\n",
  },
  {
    path: "custom/build.yaml",
    content:
      "steps:\n  - {id: implement, kind: agent, dependsOn: [], prompt: 'Build fixture'}\n  - {id: check, kind: test, dependsOn: [implement], checkId: unit}\n",
  },
];

describe("canonical factory definitions", () => {
  it("rejects a compact input whose canonical export exceeds the file limit", () => {
    const input = files();
    input[1]!.content =
      "steps:\n" +
      Array.from(
        { length: 4 },
        (_, index) =>
          `- id: step${index}\n  kind: agent\n  dependsOn: []\n  prompt: |\n${"    x\n".repeat(10_000)}`,
      ).join("");
    expect(new TextEncoder().encode(input[1]!.content).byteLength).toBeLessThan(256 * 1024);
    const result = validateFactoryFiles(input);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("Expected export size rejection");
    expect(result.failure[0]?.file).toBe("custom/build.yaml");
  });
  it("preserves semantics across YAML spelling, file order and canonical export", () => {
    const first = validateFactoryFiles(files());
    expect(Result.isSuccess(first)).toBe(true);
    if (Result.isFailure(first)) throw new Error("Expected valid fixture");
    const exported = exportFactoryFiles(first.success);
    expect(exported.map((file) => file.path)).toEqual(["factory.yaml", "workflows/main.yaml"]);
    const reimported = validateFactoryFiles(exported.toReversed());
    expect(Result.isSuccess(reimported)).toBe(true);
    if (Result.isFailure(reimported)) throw new Error("Expected valid export");
    expect(reimported.success).toEqual(first.success);
    expect(canonicalFactoryJson(reimported.success)).toBe(canonicalFactoryJson(first.success));
    expect(first.success.repositories).toEqual(["repo-a", "repo-z"]);
    const spelled = files();
    spelled[0]!.content =
      '# Comment\nworkflows: [{file: custom/build.yaml, id: "main"}]\nrepositories: [repo-a, repo-z]\nfactoryId: "a"\nschemaVersion: 1\n';
    const alternative = validateFactoryFiles(spelled);
    expect(Result.isSuccess(alternative)).toBe(true);
    if (Result.isFailure(alternative)) throw new Error("Expected equivalent YAML");
    expect(canonicalFactoryJson(alternative.success)).toBe(canonicalFactoryJson(first.success));
  });

  it.each([
    ["absolute", "/private.yaml"],
    ["parent", "../private.yaml"],
    ["nested-parent", "workflows/../private.yaml"],
    ["windows", "C:\\private.yaml"],
    ["url", "https://example.test/private.yaml"],
  ])("rejects %s workflow paths at the manifest field", (_name, path) => {
    const input = files();
    input[0]!.content = JSON.stringify({
      schemaVersion: 1,
      factoryId: "a",
      repositories: ["repo-a"],
      workflows: [{ id: "main", file: path }],
    });
    const result = validateFactoryFiles(input);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("Expected invalid path");
    expect(
      result.failure.some(
        (issue) => issue.file === "factory.yaml" && issue.path.join(".") === "workflows.0.file",
      ),
    ).toBe(true);
  });

  it.each([
    "missing",
    "duplicate-file",
    "duplicate-workflow",
    "unreferenced",
    "unknown-field",
    "unsupported-resource",
    "step-script",
    "cycle",
    "aliases",
    "duplicate-key",
    "unsupported-tag",
    "oversize",
  ])("reports bounded file/field diagnostics for %s", (failure) => {
    const input = files();
    if (failure === "missing") input.pop();
    if (failure === "duplicate-file") input.push(input[1]!);
    if (failure === "duplicate-workflow")
      input[0]!.content = input[0]!.content.replace(
        "workflows: [{id: main, file: custom/build.yaml}]",
        "workflows: [{id: main, file: custom/build.yaml}, {id: main, file: other.yaml}]",
      );
    if (failure === "unreferenced") input.push({ path: "unused.yaml", content: "ignored: false" });
    if (failure === "unknown-field") input[0]!.content += "credentials: private-fixture-value\n";
    if (failure === "unsupported-resource") input[0]!.content += "agents: []\n";
    if (failure === "step-script")
      input[1]!.content = input[1]!.content.replace(
        "checkId: unit",
        "checkId: unit, command: private-fixture-value",
      );
    if (failure === "cycle")
      input[1]!.content = input[1]!.content.replace("dependsOn: []", "dependsOn: [check]");
    if (failure === "aliases") input[1]!.content = "steps: &loop [*loop]\n";
    if (failure === "duplicate-key") input[0]!.content += "factoryId: private-fixture-value\n";
    if (failure === "unsupported-tag") input[0]!.content = "!execute private-fixture-value\n";
    if (failure === "oversize") input[1]!.content = "x".repeat(256 * 1024 + 1);
    const result = validateFactoryFiles(input);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("Expected invalid definition");
    expect(result.failure.length).toBeGreaterThan(0);
    expect(result.failure[0]?.file).toBeTruthy();
    expect(JSON.stringify(result.failure)).not.toContain("private-fixture-value");
    if (failure === "cycle")
      expect(result.failure[0]).toMatchObject({ file: "custom/build.yaml", path: ["steps"] });
    if (failure === "unknown-field")
      expect(result.failure[0]).toMatchObject({ file: "factory.yaml", path: ["credentials"] });
    if (failure === "oversize") expect(result.failure[0]?.path).toEqual([1, "content"]);
  });
  it.each(["utf8-file", "bundle"] as const)("bounds the encoded byte size of %s", (size) => {
    const input = files();
    if (size === "utf8-file") input[1]!.content = "字".repeat(100_000);
    else
      for (let index = 0; index < 9; index++)
        input.push({ path: `extra${index}.yaml`, content: "#" + "x".repeat(240 * 1024) });
    const result = validateFactoryFiles(input);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("Expected byte size rejection");
    expect(result.failure[0]?.message).toContain("size limit");
  });
});
