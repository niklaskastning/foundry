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

export function startFailureMessage(failure: unknown) {
  if (isApplicationError(failure)) {
    switch (failure.code) {
      case "unsupported_provider":
        return "This worker supports Codex factory execution only. Configure the worker with a supported Codex provider before starting.";
      case "worker_not_ready":
        return "The configured worker or provider is not ready. Check its connection and provider setup, then retry.";
      case "invalid_execution":
        return "Execution settings or required resources are incomplete. Review the workflow's roles, model and check bindings before starting.";
      case "forbidden":
        return "Current Main and worker permissions are required. Check your connection and access.";
      case "conflict":
        return "The definition or saved defaults changed. Reload and review the current configuration before trying again.";
    }
  }
  return "The operation was not confirmed. Retry uses the same command and run ID. Check the worker binding and permissions before starting new work.";
}

export function inboxDetailMessage(detail: string) {
  switch (detail) {
    case "worker_failed":
      return "Execution on the worker failed. Review the latest output and checks to identify the cause.";
    case "iterations_exhausted":
      return "Review rounds reached their limit without meeting the completion condition. Review the last result before continuing.";
    default:
      return detail;
  }
}

export function inboxFailureMessage(failure: unknown) {
  if (isInboxError(failure)) {
    switch (failure.reason) {
      case "forbidden":
        return "Your session cannot read Decisions. Check your access or sign in again.";
      case "stale_revision":
      case "command_conflict":
        return "This decision changed. Refresh to review its current state.";
      case "not_found":
        return "This decision is no longer available. Refresh or reset the filters.";
      case "unavailable":
        return "Decisions are unavailable. Refresh or reset the filters. If history still fails to load, check Main diagnostics.";
    }
  }
  return "Decisions could not be loaded. Refresh or reset the filters.";
}
