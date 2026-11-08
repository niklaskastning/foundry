import {
  AutomationMachineCredentialIssue,
  AutomationMachineCredential,
} from "./machineCredential.ts";
import * as Schema from "effect/Schema";
import {
  AutomationApplicationCommand,
  AutomationApplicationQuery,
  AutomationApplicationResult,
} from "./application.ts";
import { AutomationControlCommand, AutomationControlSnapshot } from "./control.ts";
import {
  AutomationInboxEntry,
  AutomationInboxMark,
  AutomationInboxPage,
  AutomationInboxQuery,
} from "./inbox.ts";
import {
  AutomationTriggerCommand,
  AutomationTriggerQuery,
  AutomationTriggerResult,
} from "./trigger.ts";

export const AUTOMATION_API_V1 = "/api/foundry/v1/automation";

export const AutomationApiError = Schema.Struct({
  code: Schema.Literals([
    "invalid_input",
    "forbidden",
    "not_found",
    "conflict",
    "unavailable",
    "invalid_transition",
    "writer_not_ended",
    "checkpoint_pending",
    "archive_missing",
    "workspace_changed",
    "unsupported_provider",
    "worker_not_ready",
    "invalid_execution",
    "stale_revision",
    "command_conflict",
  ]),
});

export const AutomationApiOperations = {
  credentialIssue: {
    path: "credentials/issue",
    input: AutomationMachineCredentialIssue,
    output: Schema.Struct({
      credential: AutomationMachineCredential,
      token: Schema.NullOr(Schema.String),
    }),
  },
  credentialList: {
    path: "credentials/list",
    input: Schema.Struct({}),
    output: Schema.Array(AutomationMachineCredential),
  },
  credentialRevoke: {
    path: "credentials/revoke",
    input: Schema.Struct({ id: AutomationMachineCredentialIssue.fields.id }),
    output: Schema.Null,
  },
  query: { path: "query", input: AutomationApplicationQuery, output: AutomationApplicationResult },
  command: {
    path: "command",
    input: AutomationApplicationCommand,
    output: AutomationApplicationResult,
  },
  control: { path: "control", input: AutomationControlCommand, output: AutomationControlSnapshot },
  inboxQuery: { path: "inbox/query", input: AutomationInboxQuery, output: AutomationInboxPage },
  inboxMark: { path: "inbox/mark", input: AutomationInboxMark, output: AutomationInboxEntry },
  triggersQuery: {
    path: "triggers/query",
    input: AutomationTriggerQuery,
    output: AutomationTriggerResult,
  },
  triggersCommand: {
    path: "triggers/command",
    input: AutomationTriggerCommand,
    output: AutomationTriggerResult,
  },
} as const;
