import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FoundryWorkspaceRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  repositoryPath: TrimmedNonEmptyString,
  mode: Schema.Literals(["checkout", "worktree"]),
  revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  managedRoot: TrimmedNonEmptyString,
});
export type FoundryWorkspaceRequest = typeof FoundryWorkspaceRequest.Type;

export const FoundryWorkspaceReservation = Schema.Struct({
  ...FoundryWorkspaceRequest.fields,
  workspacePath: Schema.String,
  baseCommit: Schema.String,
  branch: Schema.NullOr(Schema.String),
  state: Schema.Literals(["allocating", "ready", "released"]),
});
export type FoundryWorkspaceReservation = typeof FoundryWorkspaceReservation.Type;

export class FoundryWorkspaceError extends Schema.TaggedError<FoundryWorkspaceError>()(
  "FoundryWorkspaceError",
  {
    code: Schema.Literals([
      "invalid_request",
      "path_denied",
      "not_repository",
      "writer_busy",
      "request_conflict",
      "not_found",
      "recovery_required",
      "stop_unconfirmed",
      "storage_failed",
      "git_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
