// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem fixtures verify byte, mode, and symlink boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { type FoundryWorkerDefinitionV4 } from "@t3tools/contracts";
import {
  prepareResources,
  readResources,
  parseStructuredResult,
  codexResourceConfig,
  isolateCodexMcpConfig,
  prepareWorkspaceResources,
  prepareSandboxSkills,
} from "./WorkerResources.ts";

it.effect("verifies pinned sandbox skill bytes on restart and refuses changed resources", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sandbox-skills-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(cwd, { recursive: true, force: true })),
    );
    const skills = fixture().resources.skills;
    const directory = yield* prepareSandboxSkills(cwd, skills);
    expect(yield* prepareSandboxSkills(cwd, skills)).toBe(directory);
    const first = skills[0]!.files[0]!;
    yield* Effect.promise(() => NodeFSP.chmod(NodePath.join(directory, first.path), 0o600));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(directory, first.path), "tampered"),
    );
    expect((yield* prepareSandboxSkills(cwd, skills).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);

const fixture = (): FoundryWorkerDefinitionV4 => ({
  factoryId: "factory",
  workspaceAccess: "read",
  mcpBindings: [],
  resources: {
    agent: { id: "reviewer", name: "Reviewer" },
    instructions: "Review",
    skills: [
      {
        id: "review",
        directory: "skills/review",
        name: "review",
        description: "Review code",
        files: [
          {
            path: "skills/review/SKILL.md",
            content: "---\nname: review\ndescription: Review code\n---\nReview.",
            encoding: "utf8",
            mode: "100644",
            sha256: NodeCrypto.createHash("sha256")
              .update("---\nname: review\ndescription: Review code\n---\nReview.")
              .digest("hex"),
          },
          {
            path: "skills/review/scripts/check",
            content: "#!/bin/sh\nexit 0\n",
            encoding: "utf8",
            mode: "100755",
            sha256: NodeCrypto.createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex"),
          },
        ],
      },
    ],
    mcp: [],
    execution: { provider: "codex" },
    provenance: { instructions: [], skills: [], mcp: [], execution: { provider: "factory" } },
  },
});
it.live(
  "materializes pinned skill bytes and executable modes without running scripts, rejects drift and symlinks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-resources-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        expect(yield* readResources(directory, "legacy-thread")).toBeNull();
        expect(
          (yield* readResources(directory, "foundry-launch:v4:missing").pipe(Effect.result))._tag,
        ).toBe("Failure");
        const request = fixture();
        const prepared = yield* prepareResources(directory, "thread", request);
        expect(
          awaitText(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(prepared.directory, "skills/review/scripts/check")),
            ),
          ),
        ).toBe("#!/bin/sh\nexit 0\n");
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(prepared.directory, "skills/review/scripts/check")),
          )).mode & 0o777,
        ).toBe(0o500);
        expect((yield* readResources(directory, "thread"))?.request).toEqual(request);
        const cwd = NodePath.join(directory, "repository");
        yield* Effect.promise(() => NodeFSP.mkdir(cwd));
        const execute = NodeUtil.promisify(NodeChildProcess.execFile);
        yield* Effect.promise(() => execute("git", ["init", "-q"], { cwd }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(cwd, ".git/info/exclude"),
            "# user rule\nkeep-user-rule\n",
          ),
        );
        const mirror = yield* prepareWorkspaceResources(directory, "thread", cwd);
        expect((yield* readResources(directory, "thread"))?.nativeDirectory).toBe(mirror);
        expect(yield* prepareWorkspaceResources(directory, "thread", cwd)).toBe(mirror);
        yield* Effect.promise(() =>
          NodeFSP.rename(
            NodePath.join(prepared.directory, "workspace.json"),
            NodePath.join(directory, "workspace.saved"),
          ),
        );
        expect((yield* readResources(directory, "thread", true).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* Effect.promise(() =>
          NodeFSP.rename(
            NodePath.join(directory, "workspace.saved"),
            NodePath.join(prepared.directory, "workspace.json"),
          ),
        );

        yield* Effect.promise(async () => {
          await NodeFSP.rename(
            NodePath.join(cwd, ".agents"),
            NodePath.join(directory, "moved-agents"),
          );
          await NodeFSP.symlink(
            NodePath.join(directory, "moved-agents"),
            NodePath.join(cwd, ".agents"),
          );
        });
        expect((yield* readResources(directory, "thread").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(NodePath.join(cwd, ".agents"));
          await NodeFSP.rename(
            NodePath.join(directory, "moved-agents"),
            NodePath.join(cwd, ".agents"),
          );
          await NodeFSP.rename(
            NodePath.join(prepared.directory, "request.json"),
            NodePath.join(prepared.directory, "request.saved"),
          );
        });
        expect((yield* readResources(directory, "thread").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* Effect.promise(() =>
          NodeFSP.rename(
            NodePath.join(prepared.directory, "request.saved"),
            NodePath.join(prepared.directory, "request.json"),
          ),
        );

        expect(
          (yield* Effect.promise(() =>
            execute("git", ["status", "--porcelain", "--untracked-files=all"], { cwd }),
          )).stdout,
        ).toBe("");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(cwd, ".git/info/exclude"), "utf8"),
          ),
        ).toContain("keep-user-rule\n");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(mirror, "skills/review/unpinned.txt"), "drift"),
        );
        expect((yield* readResources(directory, "thread").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* Effect.promise(() =>
          NodeFSP.unlink(NodePath.join(mirror, "skills/review/unpinned.txt")),
        );
        expect(
          (yield* prepareResources(directory, "thread", {
            ...request,
            workspaceAccess: "write",
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* Effect.promise(async () => {
          await NodeFSP.chmod(NodePath.join(prepared.directory, "skills/review"), 0o700);
          await NodeFSP.unlink(NodePath.join(prepared.directory, "skills/review/SKILL.md"));
          await NodeFSP.symlink(
            "/etc/passwd",
            NodePath.join(prepared.directory, "skills/review/SKILL.md"),
          );
        });
        expect((yield* readResources(directory, "thread").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
);
const awaitText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

it("accepts only bounded schema-valid JSON outputs and enforces explicit native tool grants", () => {
  const schema = {
    type: "object" as const,
    additionalProperties: false as const,
    required: ["verdict"],
    properties: { verdict: { type: "string" as const, enum: ["approved", "changes_requested"] } },
  };
  expect(parseStructuredResult(schema, '{"verdict":"changes_requested"}')).toEqual({
    structuredResult: { verdict: "changes_requested" },
  });
  expect(parseStructuredResult(schema, "approved")).toEqual({ structuredResultError: "invalid" });
  expect(parseStructuredResult(schema, '{"verdict":"approved","extra":true}')).toEqual({
    structuredResultError: "invalid",
  });
  expect(parseStructuredResult(schema, undefined)).toEqual({ structuredResultError: "missing" });
  const resource = {
    id: "docs",
    name: "Docs",
    transport: "stdio" as const,
    command: "fixture",
    args: [],
    allowedTools: [],
  };
  const request = { ...fixture(), resources: { ...fixture().resources, mcp: [resource] } };
  expect(() => codexResourceConfig(request, {})).toThrow();
  const granted = {
    ...request,
    mcpBindings: [
      {
        factoryId: "factory",
        resourceId: "docs",
        generation: 1,
        enabled: true,
        definition: resource,
        allowedTools: [],
        secrets: {},
      },
    ],
  };
  expect(
    isolateCodexMcpConfig(codexResourceConfig(granted, {}), { unrelated: { command: "fixture" } })[
      "mcp_servers.unrelated.enabled"
    ],
  ).toBe(false);
  expect(() =>
    isolateCodexMcpConfig(codexResourceConfig(granted, {}), {
      "foundry-docs": { env: { injected: "yes" } },
    }),
  ).toThrow();
  expect(codexResourceConfig(granted, {})["mcp_servers.foundry-docs"]).toMatchObject({
    enabled: false,
    enabled_tools: [],
  });
  expect(() =>
    codexResourceConfig(
      { ...granted, mcpBindings: [{ ...granted.mcpBindings[0]!, enabled: false }] },
      {},
    ),
  ).toThrow();
});
