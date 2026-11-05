import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Git from "../vcs/GitVcsDriver.ts";

export const makeCheckpointWorkspaceTree = Effect.fn("CheckpointWorkspace.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  return Effect.fn("CheckpointWorkspace.tree")(function* (cwd: string, checkpointRef: string) {
    const temporary = yield* fs.makeTempDirectoryScoped();
    const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
    const run = Effect.fn("CheckpointWorkspace.git")(function* (args: ReadonlyArray<string>) {
      return (yield* git.execute({
        cwd,
        operation: "foundry.handoff.verifyTree",
        env,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.excludesFile=/dev/null",
          "-c",
          "core.filemode=true",
          ...args,
        ],
      })).stdout.trim();
    });
    // Seed pinned untracked paths so later ignore rules cannot hide their modification.
    yield* run(["read-tree", checkpointRef]);
    yield* run(["add", "-A", "--", "."]);
    return yield* run(["write-tree"]);
  }, Effect.scoped);
});
