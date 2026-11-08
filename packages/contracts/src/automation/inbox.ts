import * as Schema from "effect/Schema";
import { OrchestrationV2UserInputQuestion } from "../orchestrationV2.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const AutomationInboxKind = Schema.Literals([
  "question",
  "answer",
  "approval",
  "blocker",
  "error",
]);
export const AutomationInboxQuery = Schema.Struct({
  factoryId: Schema.optional(Key),
  kind: Schema.optional(AutomationInboxKind),
  status: Schema.optional(Schema.Literals(["open", "done", "all"])),
  unreadOnly: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Key),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type AutomationInboxQuery = typeof AutomationInboxQuery.Type;
export const AutomationInboxMark = Schema.Struct({
  commandId: Key,
  itemId: Key,
  sourceRevision: Key,
  action: Schema.Literals(["read", "unread", "done", "reopen"]),
});
export type AutomationInboxMark = typeof AutomationInboxMark.Type;
export const AutomationInboxEntry = Schema.Struct({
  id: Key,
  factoryId: Key,
  workItemId: Key,
  runId: Key,
  kind: AutomationInboxKind,
  sourceRevision: Key,
  title: Schema.String,
  detail: Schema.String,
  stepId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  requestId: Schema.NullOr(Key),
  threadId: Schema.NullOr(Key),
  environmentId: Schema.NullOr(Key),
  expectedRevision: Schema.Int,
  resultRevision: Schema.Int,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  answer: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  active: Schema.Boolean,
  isRead: Schema.Boolean,
  isDone: Schema.Boolean,
});
export type AutomationInboxEntry = typeof AutomationInboxEntry.Type;
export const AutomationInboxPage = Schema.Struct({
  items: Schema.Array(AutomationInboxEntry),
  nextCursor: Schema.NullOr(Key),
});
export type AutomationInboxPage = typeof AutomationInboxPage.Type;
export class AutomationInboxError extends Schema.TaggedError<AutomationInboxError>()(
  "AutomationInboxError",
  {
    reason: Schema.Literals([
      "forbidden",
      "not_found",
      "stale_revision",
      "command_conflict",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Inbox operation failed (${this.reason}).`;
  }
}
