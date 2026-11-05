import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import {
  FoundryWorkspaceError,
  FoundryWorkspaceRequest,
  type FoundryWorkspaceReservation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ReservationStore from "./ReservationStore.ts";
import * as WriterStopVerifier from "./WriterStopVerifier.ts";

export class WorkspaceReservations extends Context.Service<
  WorkspaceReservations,
  {
    readonly reserve: (
      input: FoundryWorkspaceRequest,
      threadId?: string,
    ) => Effect.Effect<FoundryWorkspaceReservation, FoundryWorkspaceError>;
    readonly recover: (
      requestId: string,
    ) => Effect.Effect<FoundryWorkspaceReservation, FoundryWorkspaceError>;
    readonly release: (
      requestId: string,
    ) => Effect.Effect<FoundryWorkspaceReservation, FoundryWorkspaceError>;
  }
>()("t3/foundry/workspaces/WorkspaceReservations") {}

const decodeRequest = Schema.decodeUnknownEffect(FoundryWorkspaceRequest);

export const layer = (allowedRoots: ReadonlyArray<string>) =>
  Layer.effect(
    WorkspaceReservations,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const within = (root: string, path: string) => {
        const relative = paths.relative(root, path);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${paths.sep}`) &&
          !paths.isAbsolute(relative)
        );
      };

      const git = yield* GitVcsDriver.GitVcsDriver;
      const store = yield* ReservationStore.ReservationStore;
      const stop = yield* WriterStopVerifier.WriterStopVerifier;
      const denyPath = (cause: unknown) =>
        new FoundryWorkspaceError({ code: "path_denied", cause });
      const roots = yield* Effect.forEach(allowedRoots, (root) =>
        fs.realPath(root).pipe(Effect.mapError(denyPath)),
      );
      const real = (path: string) => fs.realPath(path).pipe(Effect.mapError(denyPath));
      const gitError = (cause: unknown) => new FoundryWorkspaceError({ code: "git_failed", cause });
      const checkRepository = Effect.fn("WorkspaceReservations.checkRepository")(function* (
        path: string,
      ) {
        const top = yield* git
          .execute({
            cwd: path,
            operation: "foundry.workspace.root",
            args: ["rev-parse", "--show-toplevel"],
          })
          .pipe(Effect.mapError(gitError));
        if ((yield* real(top.stdout.trim())) !== path)
          return yield* new FoundryWorkspaceError({ code: "not_repository" });
        const common = yield* git
          .execute({
            cwd: path,
            operation: "foundry.workspace.common",
            args: ["rev-parse", "--git-common-dir"],
          })
          .pipe(Effect.mapError(gitError));
        const metadata = yield* real(paths.resolve(path, common.stdout.trim()));
        if (!roots.some((root) => within(root, metadata)))
          return yield* new FoundryWorkspaceError({ code: "path_denied" });
        return metadata;
      });
      const validate = Effect.fn("WorkspaceReservations.validate")(function* (
        reservation: FoundryWorkspaceReservation,
      ) {
        const root = yield* real(reservation.managedRoot);
        const source = yield* real(reservation.repositoryPath);
        if (
          source !== reservation.repositoryPath ||
          !roots.includes(root) ||
          !roots.some((allowed) => allowed === source || within(allowed, source))
        )
          return yield* new FoundryWorkspaceError({ code: "path_denied" });
        const sourceMetadata = yield* checkRepository(source);
        const workspace = yield* real(reservation.workspacePath);
        if (
          !roots.some((allowed) => allowed === workspace || within(allowed, workspace)) ||
          workspace !== reservation.workspacePath
        )
          return yield* new FoundryWorkspaceError({ code: "path_denied" });
        if ((yield* checkRepository(workspace)) !== sourceMetadata)
          return yield* new FoundryWorkspaceError({ code: "recovery_required" });
        if (reservation.state === "allocating" && reservation.mode === "worktree") {
          const head = yield* git
            .resolveCommit({ cwd: workspace, revision: "HEAD" })
            .pipe(Effect.mapError(gitError));
          const branch = yield* git
            .execute({
              cwd: workspace,
              operation: "foundry.workspace.branch",
              args: ["symbolic-ref", "--short", "HEAD"],
            })
            .pipe(Effect.mapError(gitError));
          if (
            head.commitSha !== reservation.baseCommit ||
            branch.stdout.trim() !== reservation.branch
          )
            return yield* new FoundryWorkspaceError({ code: "recovery_required" });
        }
      });
      const recover = Effect.fn("WorkspaceReservations.recover")(function* (requestId: string) {
        const reservation = yield* store.read(requestId);
        if (reservation.state === "released") return reservation;
        yield* validate(reservation);
        yield* store.setState(requestId, "ready");
        return yield* store.read(requestId);
      });
      return WorkspaceReservations.of({
        recover,
        reserve: Effect.fn("WorkspaceReservations.reserve")(function* (input, threadId) {
          const decoded = yield* decodeRequest(input).pipe(
            Effect.mapError(
              (cause) => new FoundryWorkspaceError({ code: "invalid_request", cause }),
            ),
          );
          const repositoryPath = yield* real(decoded.repositoryPath);
          const managedRoot = yield* real(decoded.managedRoot);
          if (
            !roots.includes(managedRoot) ||
            !roots.some((root) => root === repositoryPath || within(root, repositoryPath))
          )
            return yield* new FoundryWorkspaceError({ code: "path_denied" });
          if (input.mode === "worktree" && repositoryPath === managedRoot)
            return yield* new FoundryWorkspaceError({ code: "path_denied" });
          yield* checkRepository(repositoryPath);
          const existing = yield* store.read(input.requestId).pipe(
            Effect.catchTags({
              FoundryWorkspaceError: (error) =>
                error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
            }),
          );
          if (existing) {
            if (
              existing.repositoryPath !== repositoryPath ||
              existing.mode !== input.mode ||
              existing.managedRoot !== managedRoot
            )
              return yield* new FoundryWorkspaceError({ code: "request_conflict" });
            if (existing.state === "allocating")
              return yield* new FoundryWorkspaceError({ code: "recovery_required" });
            if (existing.state === "ready") yield* validate(existing);
            return existing;
          }
          const key = Buffer.from(
            yield* crypto
              .digest("SHA-256", new TextEncoder().encode(input.requestId))
              .pipe(Effect.mapError(denyPath)),
          ).toString("hex");
          const workspacePath =
            input.mode === "checkout"
              ? repositoryPath
              : paths.join(managedRoot, `workspace-${key}`);
          if (
            input.mode === "worktree" &&
            (yield* fs.exists(workspacePath).pipe(Effect.mapError(denyPath)))
          )
            return yield* new FoundryWorkspaceError({ code: "path_denied" });
          const base = yield* git
            .resolveCommit({ cwd: repositoryPath, revision: "HEAD" })
            .pipe(Effect.mapError(gitError));
          const reservation: FoundryWorkspaceReservation = {
            ...decoded,
            repositoryPath,
            managedRoot,
            workspacePath,
            baseCommit: base.commitSha,
            branch: input.mode === "worktree" ? `foundry/${key}` : null,
            state: "allocating",
          };
          if (!(yield* store.claim(reservation, threadId)))
            return yield* new FoundryWorkspaceError({ code: "writer_busy" });
          // Failure or interruption leaves the durable claim intact; recovery never deletes user files.
          if (input.mode === "worktree")
            yield* git
              .createWorktree({
                cwd: repositoryPath,
                refName: base.commitSha,
                newRefName: `foundry/${key}`,
                path: workspacePath,
              })
              .pipe(Effect.mapError(gitError));
          return yield* recover(input.requestId);
        }),
        release: Effect.fn("WorkspaceReservations.release")(function* (requestId) {
          const reservation = yield* store.read(requestId);
          if (reservation.state === "released") return reservation;
          yield* stop.confirmStopped(reservation);
          yield* store.setState(requestId, "released");
          return yield* store.read(requestId);
        }),
      });
    }),
  );
