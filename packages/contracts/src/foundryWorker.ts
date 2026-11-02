import {
  CommandId,
  ProjectId,
  ThreadId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FoundryWorkerStatus = Schema.Struct({
  online: Schema.Literal(true),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerReady: Schema.Boolean,
  providerState: Schema.Literals([
    "unbound",
    "missing",
    "unsupported_provider",
    "disabled",
    "not_installed",
    "login_required",
    "auth_unknown",
    "version_unknown",
    "incompatible",
    "unavailable",
    "ready",
  ]),
  version: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
  capacityAvailable: Schema.NullOr(Schema.Boolean),
  activeRuns: Schema.NullOr(Schema.Number),
});
export type FoundryWorkerStatus = typeof FoundryWorkerStatus.Type;
export class FoundryWorkerError extends Schema.TaggedError<FoundryWorkerError>()(
  "FoundryWorkerError",
  { code: Schema.Literals(["not_enabled", "probe_failed"]) },
) {}

export const FoundryWorkerLaunchInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type FoundryWorkerLaunchInput = typeof FoundryWorkerLaunchInput.Type;
export const FoundryWorkerLaunchReceipt = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  acceptedAt: IsoDateTime,
  sequence: NonNegativeInt,
});
export type FoundryWorkerLaunchReceipt = typeof FoundryWorkerLaunchReceipt.Type;
export class FoundryWorkerLaunchError extends Schema.TaggedError<FoundryWorkerLaunchError>()(
  "FoundryWorkerLaunchError",
  {
    code: Schema.Literals([
      "not_enabled",
      "project_denied",
      "provider_disabled",
      "provider_not_ready",
      "command_conflict",
      "launch_failed",
    ]),
  },
) {}
