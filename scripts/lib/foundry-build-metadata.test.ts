// @effect-diagnostics nodeBuiltinImport:off -- This build-bootstrap test owns an isolated real Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { foundryBuildMetadata } from "./foundry-build-metadata.ts";

it("requires a pinned archive revision without claiming a clean Git checkout", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "foundry-build-source-"));
  try {
    const revision = "a".repeat(40);
    expect(foundryBuildMetadata(root, revision)).toEqual({ revision, dirty: true });
    for (const invalid of [undefined, "unknown", "main", "a".repeat(39)])
      expect(() => foundryBuildMetadata(root, invalid)).toThrow();
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    const clean = foundryBuildMetadata(root);
    expect(clean.dirty).toBe(false);
    expect(clean.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(() => foundryBuildMetadata(root, revision)).toThrow();
    NodeFS.writeFileSync(NodePath.join(root, "untracked"), "fixture");
    expect(foundryBuildMetadata(root)).toEqual({ revision: clean.revision, dirty: true });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
