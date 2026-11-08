import { expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import {
  validateFactoryFiles,
  exportFactoryFiles,
  migrateFactoryDefinitionV4,
} from "./factoryDefinition.ts";
const fixture = () => [
  {
    path: "factory.yaml",
    content: JSON.stringify({
      schemaVersion: 4,
      factoryId: "factory",
      repositories: ["repo"],
      workflows: [{ id: "build", file: "workflows/build.yaml" }],
      agents: [{ id: "worker", file: "agents/worker.yaml" }],
      skills: [{ id: "proof", directory: "skills/proof" }],
      mcp: [],
    }),
  },
  {
    path: "workflows/build.yaml",
    content: JSON.stringify({
      id: "build",
      limits: { maxConcurrentAgents: 2, maxAgentExecutions: 4 },
      steps: [{ id: "work", kind: "agent", agent: "worker", instructions: "Work", dependsOn: [] }],
    }),
  },
  {
    path: "agents/worker.yaml",
    content: JSON.stringify({
      id: "worker",
      name: "Worker",
      description: "Works",
      instructions: "Be precise",
      skills: ["proof"],
      mcp: [],
    }),
  },
  {
    path: "skills/proof/SKILL.md",
    content: "---\nname: proof\ndescription: Collect evidence\n---\nRecord evidence.",
  },
  {
    path: "skills/proof/scripts/proof.sh",
    content: "#!/bin/sh\nexit 0\n",
    mode: "100755" as const,
  },
];
it("pins complete skill files and modes across export and rejects drift, escaped paths and missing resources", () => {
  const files = fixture();
  const parsed = validateFactoryFiles(files);
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isFailure(parsed)) throw new Error(JSON.stringify(parsed.failure));
  const exported = exportFactoryFiles(parsed.success);
  expect(validateFactoryFiles(exported)).toEqual(parsed);
  expect(exported.find((file) => file.path.endsWith("proof.sh"))?.mode).toBe("100755");
  for (const bad of [
    files.slice(0, 3),
    [...files, { path: "../outside", content: "x" }],
    [...files, { path: "skills/unregistered/SKILL.md", content: "x" }],
    exported.map((file) =>
      file.path.endsWith("proof.sh") ? { ...file, content: "changed" } : file,
    ),
  ])
    expect(Result.isFailure(validateFactoryFiles(bad))).toBe(true);
});

it("resolves each use independently with stable resource provenance and rejects invalid graphs and schemas", async () => {
  const { resolveFactoryV4Agent } = await import("./factoryDefinition.ts");
  const files = fixture();
  const workflow = {
    id: "build",
    agentDefaults: {
      extend: { instructions: "Workflow guidance", skills: ["proof"] },
      execution: { model: "workflow-model" },
    },
    limits: { maxConcurrentAgents: 2, maxAgentExecutions: 10 },
    steps: [
      {
        id: "left",
        kind: "agent",
        agent: "worker",
        instructions: "Left task",
        dependsOn: [],
        extend: { instructions: "Step guidance", skills: ["proof"] },
        execution: { options: { reasoningEffort: "high" } },
      },
      { id: "right", kind: "agent", agent: "worker", instructions: "Right task", dependsOn: [] },
    ],
  };
  files[1]!.content = JSON.stringify(workflow);
  files.push({
    path: "skills/proof/assets/data.bin",
    content: btoa("\x00\xff\x01"),
    encoding: "base64",
  } as (typeof files)[number]);
  const parsed = validateFactoryFiles(files);
  if (Result.isFailure(parsed) || parsed.success.schemaVersion !== 4)
    throw new Error("Expected v4");
  const snapshot = { ...parsed.success, workflow: parsed.success.workflows[0]! };
  const left = snapshot.workflow.steps[0]!;
  const right = snapshot.workflow.steps[1]!;
  if (left.kind !== "agent" || right.kind !== "agent") throw new Error("Expected agent");
  const resolved = resolveFactoryV4Agent(snapshot, left);
  expect(resolved.instructions).toBe(
    "Be precise\n\nWorkflow guidance\n\nStep guidance\n\nLeft task",
  );
  expect(resolved.skills).toHaveLength(1);
  expect(resolved.provenance.skills).toEqual([
    { id: "proof", sources: ["agent", "workflow", "step"] },
  ]);
  expect(resolved.execution).toEqual({
    provider: "codex",
    model: "workflow-model",
    options: { reasoningEffort: "high" },
  });
  expect(resolveFactoryV4Agent(snapshot, right).instructions).not.toContain("Step guidance");
  expect(snapshot.agents[0]?.instructions).toBe("Be precise");
  expect(validateFactoryFiles(exportFactoryFiles(parsed.success).toReversed())).toEqual(parsed);
  const swarm = {
    id: "writers",
    kind: "swarm",
    dependsOn: [],
    maxParallel: 2,
    join: { policy: "all", onFailure: "collect" },
    steps: workflow.steps,
  };
  const integration = {
    ...workflow.steps[0],
    id: "integrate",
    dependsOn: ["writers"],
    workspace: {
      access: "write",
      from: { ref: "steps.writers.output.members.left.artifacts.checkpoint" },
    },
    inputs: { right: { ref: "steps.writers.output.members.right.artifacts.checkpoint" } },
  };
  const withGraph = (steps: unknown[]) =>
    files.map((file) =>
      file.path === "workflows/build.yaml"
        ? { ...file, content: JSON.stringify({ ...workflow, steps }) }
        : file,
    );
  expect(Result.isSuccess(validateFactoryFiles(withGraph([swarm, integration])))).toBe(true);
  for (const ref of [
    "steps.writers.output.members.missing.artifacts.checkpoint",
    "steps.writers.output.fake.artifacts.checkpoint",
  ])
    expect(
      Result.isFailure(
        validateFactoryFiles(
          withGraph([swarm, { ...integration, workspace: { access: "write", from: { ref } } }]),
        ),
      ),
    ).toBe(true);
  for (const steps of [
    [{ ...workflow.steps[0], dependsOn: ["missing"] }],
    [{ ...workflow.steps[0], dependsOn: ["left"] }],
    [{ ...workflow.steps[0], inputs: { leak: { ref: "steps.right.output" } } }, workflow.steps[1]],
    [{ ...workflow.steps[0], workspace: { access: "read", from: { ref: "inputs.code" } } }],
    [
      {
        ...workflow.steps[0],
        resultSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ],
    [
      {
        id: "group",
        kind: "swarm",
        dependsOn: [],
        maxParallel: 2,
        join: { policy: "quorum", minSuccesses: 3, onFailure: "collect" },
        steps: workflow.steps,
      },
    ],
    [
      {
        id: "loop",
        kind: "loop",
        dependsOn: [],
        maxIterations: 2,
        onExhausted: "fail",
        until: { exists: { ref: "steps.left.output" } },
        steps: workflow.steps.map((step) => ({ ...step, workspace: { access: "write" } })),
      },
    ],
  ])
    expect(
      Result.isFailure(
        validateFactoryFiles(
          files.map((file) =>
            file.path === "workflows/build.yaml"
              ? { ...file, content: JSON.stringify({ ...workflow, steps }) }
              : file,
          ),
        ),
      ),
    ).toBe(true);
});

it("migrates legacy resources explicitly while preserving task text, execution and sequential checkpoint bases", () => {
  const legacy = {
    schemaVersion: 2 as const,
    factoryId: "factory",
    repositories: ["repo"],
    defaults: { provider: "codex" as const, model: "base-model" },
    roles: [
      {
        id: "Coder",
        name: "Coder",
        description: "Codes",
        instructions: "Preserve behavior",
        skills: ["Proof"],
      },
    ],
    skills: [{ id: "Proof", name: "Evidence", instructions: "Collect evidence" }],
    workflows: [
      {
        id: "Build",
        steps: [
          {
            id: "Implement",
            kind: "agent" as const,
            prompt: "Implement",
            role: "Coder",
            dependsOn: [],
          },
          { id: "Fix", kind: "agent" as const, prompt: "Fix", role: "Coder", dependsOn: [] },
          { id: "Test", kind: "test" as const, checkId: "unit", dependsOn: [] },
        ],
      },
    ],
  };
  const before = JSON.stringify(legacy);
  const files = migrateFactoryDefinitionV4(legacy);
  expect(JSON.stringify(legacy)).toBe(before);
  const parsed = validateFactoryFiles(files);
  if (Result.isFailure(parsed) || parsed.success.schemaVersion !== 4)
    throw new Error("Expected migrated v4");
  expect(parsed.success.agents[0]).toMatchObject({
    id: "coder",
    instructions: "Preserve behavior",
    skills: ["proof"],
  });
  expect(parsed.success.workflows[0]?.steps[1]).toMatchObject({
    instructions: "Fix",
    dependsOn: ["implement"],
    workspace: { access: "write", from: { ref: "steps.implement.artifacts.checkpoint" } },
  });
  expect(parsed.success.workflows[0]?.steps[2]).toMatchObject({
    checkId: "unit",
    dependsOn: ["fix"],
    workspace: { access: "read", from: { ref: "steps.fix.artifacts.checkpoint" } },
  });
  expect(parsed.success.skills[0]?.files[0]?.content).toContain("Collect evidence");
});

it("loads named definitions and Git-owned triggers while rejecting dangling trigger references", () => {
  const files = fixture();
  const manifest = JSON.parse(files[0]!.content);
  const trigger = {
    id: "nightly",
    name: "Nightly build",
    workflow: "build",
    repository: "repo",
    source: {
      kind: "schedule",
      config: {
        timeZone: "UTC",
        timeOfDay: "12:00",
        weekdays: [1],
        catchUp: "skip",
        maxCatchUp: 1,
        overlap: "wait",
      },
    },
    target: {
      deviceId: "11111111-1111-4111-8111-111111111111",
      environmentId: "worker",
      projectId: "project",
      model: "replay",
      checks: [],
      requiredArtifacts: [],
    },
  };
  files[0]!.content = JSON.stringify({ ...manifest, name: "Build factory", triggers: [trigger] });
  const parsed = validateFactoryFiles(files);
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isFailure(parsed) || parsed.success.schemaVersion !== 4)
    throw new Error("Invalid fixture");
  expect(parsed.success.name).toBe("Build factory");
  expect(parsed.success.triggers?.[0]?.name).toBe("Nightly build");
  expect(validateFactoryFiles(exportFactoryFiles(parsed.success))).toEqual(parsed);
  for (const triggers of [
    [{ ...trigger, workflow: "missing" }],
    [trigger, trigger],
    [{ ...trigger, repository: "other" }],
  ]) {
    files[0]!.content = JSON.stringify({ ...manifest, triggers });
    expect(Result.isFailure(validateFactoryFiles(files))).toBe(true);
  }
});

it("loads scorer resources through the same bounded Git registry and preserves legacy snapshots", () => {
  const files = fixture();
  const manifest = JSON.parse(files[0]!.content);
  files[0]!.content = JSON.stringify({
    ...manifest,
    scorers: [{ id: "quality", file: "scorers/quality.yaml" }],
  });
  const scorer = {
    id: "quality",
    name: "Quality",
    criteria: [{ id: "proof", instructions: "Check evidence", threshold: 0.8 }],
    judge: { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
    sampling: { rate: 1, automatic: false },
  };
  files.push({ path: "scorers/quality.yaml", content: JSON.stringify(scorer) });
  const parsed = validateFactoryFiles(files);
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isFailure(parsed) || parsed.success.schemaVersion !== 4)
    throw new Error("Invalid fixture");
  expect(parsed.success.scorers).toEqual([scorer]);
  expect(validateFactoryFiles(exportFactoryFiles(parsed.success))).toEqual(parsed);
  files.at(-1)!.content = JSON.stringify({ ...scorer, id: "wrong" });
  expect(Result.isFailure(validateFactoryFiles(files))).toBe(true);
  const legacy = validateFactoryFiles(fixture());
  if (Result.isFailure(legacy)) throw new Error("Invalid legacy fixture");
  expect("scorers" in legacy.success).toBe(false);
});
