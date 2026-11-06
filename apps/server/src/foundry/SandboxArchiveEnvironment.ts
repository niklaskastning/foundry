import {
  CheckpointRef,
  FoundrySandboxArchiveError,
  type ThreadId,
  type FoundrySandboxArchiveManifest,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as SandboxArchive from "./SandboxArchive.ts";

export class SandboxArchiveEnvironment extends Context.Service<
  SandboxArchiveEnvironment,
  {
    readonly capture: (input: {
      readonly allocationId: string;
      readonly fence: number;
      readonly cwd: string;
      readonly attachmentsDir: string;
    }) => Effect.Effect<
      {
        readonly threadIds: ReadonlyArray<ThreadId>;
        readonly manifests: ReadonlyArray<FoundrySandboxArchiveManifest>;
      },
      FoundrySandboxArchiveError
    >;
  }
>()("t3/foundry/SandboxArchiveEnvironment") {}

const isArchiveError = Schema.is(FoundrySandboxArchiveError);

export const layer = Layer.effect(
  SandboxArchiveEnvironment,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const archive = yield* SandboxArchive.SandboxArchive;
    const git = yield* Git.makeVcsDriver;
    const driver = yield* Git.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return SandboxArchiveEnvironment.of({
      capture: Effect.fn("SandboxArchiveEnvironment.capture")(
        function* (input) {
          const threads = yield* sql<{
            threadId: ThreadId;
          }>`SELECT DISTINCT stream_id AS "threadId" FROM orchestration_events
        WHERE aggregate_kind='thread' AND application_event_version=2 ORDER BY stream_id LIMIT 129`;
          if (threads.length > 128)
            return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
          const root = yield* fs.realPath(path.dirname(input.cwd));
          const commonDirectory = Effect.fn("SandboxArchiveEnvironment.commonDirectory")(function* (
            cwd: string,
          ) {
            const value = (yield* driver.execute({
              cwd,
              operation: "sandbox.archive.commonDirectory",
              args: ["rev-parse", "--git-common-dir"],
            })).stdout.trim();
            return yield* fs.realPath(path.resolve(cwd, value));
          });
          const common = threads.length > 0 ? yield* commonDirectory(input.cwd) : undefined;
          const workspaces = new Map<string, string>();
          const manifests = yield* Effect.forEach(threads, ({ threadId }) =>
            Effect.gen(function* () {
              const records = yield* sql<{
                workspace: string | null;
              }>`SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) AS workspace
          FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${threadId}`;
              if (!records[0]?.workspace)
                return yield* new FoundrySandboxArchiveError({ code: "incomplete" });
              const cwd = yield* fs.realPath(records[0].workspace);
              const relativeWorkspacePath = path.relative(root, cwd).split(path.sep).join("/");
              if (
                !relativeWorkspacePath ||
                relativeWorkspacePath.split("/").some((part) => part.startsWith(".")) ||
                path.isAbsolute(relativeWorkspacePath) ||
                (yield* commonDirectory(cwd)) !== common
              )
                return yield* new FoundrySandboxArchiveError({ code: "foreign_archive" });
              const checkpointRef = CheckpointRef.make(
                `refs/foundry/sandbox-final/${input.allocationId}/${input.fence}/${artifactSha256(new TextEncoder().encode(relativeWorkspacePath))}`,
              );
              const existing = workspaces.get(cwd);
              if (!existing) {
                if (!(yield* git.checkpoints.hasCheckpointRef({ cwd, checkpointRef })))
                  yield* git.checkpoints.captureCheckpoint({ cwd, checkpointRef });
                workspaces.set(cwd, checkpointRef);
              }
              return yield* archive.capture({
                ...input,
                cwd,
                relativeWorkspacePath,
                threadId,
                checkpointRef: existing ?? checkpointRef,
              });
            }),
          );
          const final = yield* sql<{
            threadId: ThreadId;
          }>`SELECT DISTINCT stream_id AS "threadId" FROM orchestration_events
        WHERE aggregate_kind='thread' AND application_event_version=2 ORDER BY stream_id LIMIT 129`;
          if (
            final.length !== threads.length ||
            final.some((row, index) => row.threadId !== threads[index]?.threadId)
          )
            return yield* new FoundrySandboxArchiveError({ code: "changed" });
          return { threadIds: threads.map((row) => row.threadId), manifests };
        },
        Effect.mapError((cause) =>
          isArchiveError(cause) ? cause : new FoundrySandboxArchiveError({ code: "unavailable" }),
        ),
      ),
    });
  }),
);
