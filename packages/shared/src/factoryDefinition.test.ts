import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import {
  canonicalFactoryJson,
  exportFactoryFiles,
  validateFactoryFiles,
  resolveFactoryWorkflow,
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
    for (const content of [
      "steps: [{id: agent, kind: agent, dependsOn: [], prompt: Work}]\n",
      "steps: [{id: approval, kind: approval, dependsOn: [], prompt: Review}]\n",
      files()[1]!.content +
        "  - {id: approval, kind: approval, dependsOn: [check], prompt: Review}\n" +
        "  - {id: publish, kind: publish, dependsOn: [approval], target: pull_request}\n",
    ]) {
      const supported = files();
      supported[1]!.content = content;
      const parsed = validateFactoryFiles(supported);
      expect(Result.isSuccess(parsed)).toBe(true);
      if (Result.isFailure(parsed)) throw new Error("Expected supported workflow");
      expect(validateFactoryFiles(exportFactoryFiles(parsed.success))).toEqual(parsed);
    }
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

  it("resolves shared roles with ordered skills and layered defaults into independent snapshots", () => {
    const input = [
      {
        path: "factory.yaml",
        content: JSON.stringify({
          schemaVersion: 2,
          factoryId: "a",
          repositories: ["repo-a"],
          defaults: { provider: "codex", model: "base-model", options: { reasoningEffort: "low" } },
          skills: [
            { id: "tests", name: "Testing", instructions: "Run focused tests." },
            { id: "review", name: "Review", instructions: "Inspect the final diff." },
          ],
          roles: [
            {
              id: "implementer",
              name: "Implementer",
              description: "Implement a bounded change",
              instructions: "Preserve existing behavior.",
              skills: ["tests"],
              execution: { model: "role-model" },
            },
          ],
          workflows: [
            { id: "build", file: "build.yaml" },
            { id: "repair", file: "repair.yaml" },
          ],
        }),
      },
      {
        path: "build.yaml",
        content: JSON.stringify({
          steps: [
            {
              id: "work",
              kind: "agent",
              dependsOn: [],
              prompt: "Build the feature",
              role: "implementer",
              skills: ["tests", "review"],
              execution: { options: { reasoningEffort: "high" } },
            },
          ],
        }),
      },
      {
        path: "repair.yaml",
        content: JSON.stringify({
          steps: [
            {
              id: "work",
              kind: "agent",
              dependsOn: [],
              prompt: "Fix the bug",
              role: "implementer",
            },
          ],
        }),
      },
    ];
    const parsed = validateFactoryFiles(input);
    if (Result.isFailure(parsed)) throw new Error(JSON.stringify(parsed.failure));
    expect(validateFactoryFiles(exportFactoryFiles(parsed.success))).toEqual(parsed);
    const before = resolveFactoryWorkflow(parsed.success, "build");
    expect(before[0]).toMatchObject({
      prompt: "Build the feature",
      resolved: {
        role: { id: "implementer", instructions: "Preserve existing behavior." },
        skills: [{ id: "tests" }, { id: "review" }],
        execution: { provider: "codex", model: "role-model", options: { reasoningEffort: "high" } },
        instructions:
          "Preserve existing behavior.\n\nSkill: Testing (tests)\nRun focused tests.\n\nSkill: Review (review)\nInspect the final diff.",
      },
    });
    expect(resolveFactoryWorkflow(parsed.success, "repair")[0]).toMatchObject({
      resolved: {
        execution: { model: "role-model", options: { reasoningEffort: "low" } },
        skills: [{ id: "tests" }],
      },
    });
    const expanded = validateFactoryFiles(
      exportFactoryFiles({
        ...parsed.success,
        skills: [{ id: "tests", name: "Testing", instructions: "x".repeat(20_000) }],
        workflows: ["first", "second"].map((id) => ({
          id,
          steps: Array.from({ length: 100 }, (_, index) => ({
            id: `work${index}`,
            kind: "agent" as const,
            dependsOn: [],
            prompt: "Work",
            role: "implementer",
          })),
        })),
      }),
    );
    expect(Result.isFailure(expanded)).toBe(true);
    if (Result.isSuccess(expanded)) throw new Error("Expected expanded snapshot size rejection");
    expect(expanded.failure[0]?.message).toContain("size limit");
    const changed = {
      ...parsed.success,
      roles: parsed.success.roles!.map((role) => ({
        ...role,
        instructions: "New behavior",
        execution: { model: "new-model" },
      })),
    };
    expect(resolveFactoryWorkflow(changed, "build")[0]).toMatchObject({
      resolved: { role: { instructions: "New behavior" }, execution: { model: "new-model" } },
    });
    expect(before[0]).toMatchObject({
      resolved: {
        role: { instructions: "Preserve existing behavior." },
        execution: { model: "role-model" },
      },
    });
    for (const [field, value] of [
      ["role", "missing"],
      ["skills", ["missing"]],
      ["execution", { provider: "claude" }],
      ["execution", { options: { unsupportedOption: true } }],
      ["resolved", { instructions: "Bypass validation" }],
    ] as const) {
      const invalid = input.map((file) =>
        file.path === "build.yaml"
          ? {
              ...file,
              content: JSON.stringify({
                steps: [
                  { id: "work", kind: "agent", dependsOn: [], prompt: "Work", [field]: value },
                ],
              }),
            }
          : file,
      );
      const rejected = validateFactoryFiles(invalid);
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isSuccess(rejected))
        throw new Error("Expected missing or unsupported resource rejection");
      expect(rejected.failure[0]?.file).toBe("build.yaml");
      if (field === "execution" && "provider" in value)
        expect(rejected.failure[0]?.message).toContain("Codex");
    }
    for (const manifest of [
      { ...JSON.parse(input[0]!.content), schemaVersion: 1 },
      { ...JSON.parse(input[0]!.content), skills: [] },
      {
        ...JSON.parse(input[0]!.content),
        roles: [
          {
            id: "unused",
            name: "Unused",
            description: "Invalid unused role",
            instructions: "Work",
            skills: ["missing"],
          },
        ],
      },
    ]) {
      expect(
        Result.isFailure(
          validateFactoryFiles([
            { path: "factory.yaml", content: JSON.stringify(manifest) },
            ...input.slice(1),
          ]),
        ),
      ).toBe(true);
    }
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
    "publish-no-test",
    "publish-not-last",
    "publish-repeat",
    "publish-after-agent",
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
    const publish = "  - {id: publish, kind: publish, dependsOn: [check], target: pull_request}\n";
    if (failure === "publish-no-test")
      input[1]!.content =
        "steps: [{id: publish, kind: publish, dependsOn: [], target: pull_request}]\n";
    if (failure === "publish-not-last")
      input[1]!.content +=
        publish + "  - {id: later, kind: test, dependsOn: [publish], checkId: integration}\n";
    if (failure === "publish-repeat")
      input[1]!.content +=
        publish + "  - {id: later, kind: publish, dependsOn: [publish], target: pull_request}\n";
    if (failure === "publish-after-agent")
      input[1]!.content +=
        "  - {id: later, kind: agent, dependsOn: [check], prompt: Work}\n" + publish;
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
    if (failure === "cycle" || failure.startsWith("publish-"))
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
