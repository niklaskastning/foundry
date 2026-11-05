import * as Schema from "effect/Schema";
import {
  AutomationTriggerError,
  AutomationApplicationError,
  AutomationControlError,
  AutomationInboxError,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isTriggerError = Schema.is(AutomationTriggerError);
const isApplicationError = Schema.is(AutomationApplicationError);
const isControlError = Schema.is(AutomationControlError);
const isInboxError = Schema.is(AutomationInboxError);
export function isDefinitiveAutomationFailure(failure: unknown) {
  return (
    isAuthorizationError(failure) ||
    ((isApplicationError(failure) || isControlError(failure) || isTriggerError(failure)) &&
      failure.code !== "unavailable") ||
    (isInboxError(failure) && failure.reason !== "unavailable")
  );
}

export function handoffFailureMessage(failure: unknown) {
  if (isApplicationError(failure)) {
    switch (failure.code) {
      case "writer_not_ended":
        return "The writer has not ended. Stop or finish interactive work and wait for confirmation before trying again.";
      case "checkpoint_pending":
        return "The required checkpoint is not confirmed yet. Refresh the result before trying again.";
      case "archive_missing":
        return "The confirmed archive or Git bundle is missing. Restoration and return remain blocked until the required data is available.";
      case "workspace_changed":
        return "The workspace no longer matches the confirmed revision. Reopen interactive work to reconcile the changes before returning.";
      case "conflict":
        return "The handoff or run revision changed. Refresh and review the current state before making another decision.";
      case "forbidden":
        return "Current Main and worker permissions are required for this handoff. Check your connection and access.";
      case "unavailable":
        return "Confirmation was not received. Retry the same decision to reconcile its saved command; do not start another handoff.";
    }
  }
  return failure instanceof Error ? failure.message : "Handoff was not confirmed.";
}
