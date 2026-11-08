import * as Schema from "effect/Schema";

export const AutomationMachineCredentialIssue = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  factoryIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type AutomationMachineCredentialIssue = typeof AutomationMachineCredentialIssue.Type;
export const AutomationMachineCredential = Schema.Struct({
  ...AutomationMachineCredentialIssue.fields,
  scope: Schema.Literal("automation:read"),
  revoked: Schema.Boolean,
});
export type AutomationMachineCredential = typeof AutomationMachineCredential.Type;
export class AutomationMachineCredentialError extends Schema.TaggedError<AutomationMachineCredentialError>()(
  "AutomationMachineCredentialError",
  { code: Schema.Literals(["invalid_input", "forbidden", "conflict", "unavailable"]) },
) {}
