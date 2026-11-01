// @effect-diagnostics nodeBuiltinImport:off -- Synchronous build bootstrap reads Git provenance before launching the build.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function foundryBuildMetadata(root: string, archiveRevision?: string) {
  if (!NodeFS.existsSync(NodePath.join(root, ".git"))) {
    if (!archiveRevision || !/^[a-f0-9]{40}$/.test(archiveRevision))
      throw new Error(
        "A source archive requires FOUNDRY_ARCHIVE_REVISION with its full commit SHA.",
      );
    // An archive supplies provenance but cannot establish a clean Git working tree.
    return { revision: archiveRevision, dirty: true };
  }
  const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (archiveRevision !== undefined && archiveRevision !== revision)
    throw new Error("Archive revision differs from the Git checkout.");
  const dirty =
    NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  return { revision, dirty };
}
