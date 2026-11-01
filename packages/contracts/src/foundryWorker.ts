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
