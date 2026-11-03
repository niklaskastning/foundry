import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, EnvironmentId } from "./baseSchemas.ts";
import { FoundryInstanceId } from "./foundry.ts";
import { FoundryDeviceId } from "./foundryDevices.ts";
import { FoundryArtifactOwner, FoundryArtifactReference } from "./foundryArtifact.ts";
import { OrchestrationV2DomainEventJson } from "./orchestrationV2.ts";

export const FOUNDRY_ARCHIVE_PAGE_BYTES = 1024 * 1024;

export const FoundryArchiveOwner = FoundryArtifactOwner;
export type FoundryArchiveOwner = typeof FoundryArchiveOwner.Type;
export const FoundryArchiveEvent = Schema.Struct({
  sequence: PositiveInt,
  sourceSequence: PositiveInt,
  event: OrchestrationV2DomainEventJson,
});
export type FoundryArchiveEvent = typeof FoundryArchiveEvent.Type;
export const FoundryArchiveIngest = Schema.Struct({
  instanceId: FoundryInstanceId,
  owner: FoundryArchiveOwner,
  sourceHead: NonNegativeInt,
  sourceComplete: Schema.Boolean,
  events: Schema.Array(FoundryArchiveEvent).check(Schema.isMaxLength(50)),
});
export type FoundryArchiveIngest = typeof FoundryArchiveIngest.Type;
export const FoundryArchiveStatus = Schema.Struct({
  owner: FoundryArchiveOwner,
  confirmedCursor: NonNegativeInt,
  confirmedSourceSequence: NonNegativeInt,
  sourceHead: NonNegativeInt,
  sourceComplete: Schema.Boolean,
  complete: Schema.Boolean,
  missingArtifacts: Schema.Array(FoundryArtifactReference),
  missingAttachmentCount: NonNegativeInt,
});
export type FoundryArchiveStatus = typeof FoundryArchiveStatus.Type;
export const FoundryArchiveRead = Schema.Struct({
  owner: FoundryArchiveOwner,
  after: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type FoundryArchiveRead = typeof FoundryArchiveRead.Type;
export const FoundryArchivePage = Schema.Struct({
  ...FoundryArchiveStatus.fields,
  events: Schema.Array(FoundryArchiveEvent),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type FoundryArchivePage = typeof FoundryArchivePage.Type;
export const FoundryArchiveList = Schema.Struct({
  before: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,17}$/))),
});
export type FoundryArchiveList = typeof FoundryArchiveList.Type;
export const FoundryArchiveListPage = Schema.Struct({
  items: Schema.Array(FoundryArchiveStatus),
  nextCursor: Schema.NullOr(Schema.String),
});
export type FoundryArchiveListPage = typeof FoundryArchiveListPage.Type;
export const FoundryArchiveRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("ingest"), input: FoundryArchiveIngest }),
  Schema.Struct({ op: Schema.Literal("cursor"), input: FoundryArchiveOwner }),
  Schema.Struct({ op: Schema.Literal("read"), input: FoundryArchiveRead }),
  Schema.Struct({ op: Schema.Literal("list"), input: FoundryArchiveList }),
]);
export type FoundryArchiveRequest = typeof FoundryArchiveRequest.Type;
export const FoundryArchiveMachineRequest = Schema.Struct({
  protocolVersion: Schema.Literal("archive-1"),
  instanceId: FoundryInstanceId,
  deviceId: FoundryDeviceId,
  environmentId: EnvironmentId,
  generation: PositiveInt,
  issuedAt: PositiveInt,
  request: FoundryArchiveRequest,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type FoundryArchiveMachineRequest = typeof FoundryArchiveMachineRequest.Type;
export class FoundryArchiveError extends Schema.TaggedError<FoundryArchiveError>()(
  "FoundryArchiveError",
  {
    code: Schema.Literals([
      "invalid_request",
      "forbidden",
      "conflict",
      "incomplete",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Foundry archive operation failed (${this.code}).`;
  }
}
