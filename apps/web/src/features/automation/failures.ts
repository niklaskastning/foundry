import * as Schema from "effect/Schema";
import {
  AutomationApplicationError,
  AutomationControlError,
  AutomationInboxError,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isApplicationError = Schema.is(AutomationApplicationError);
const isControlError = Schema.is(AutomationControlError);
const isInboxError = Schema.is(AutomationInboxError);
export function isDefinitiveAutomationFailure(failure: unknown) {
  return (
    isAuthorizationError(failure) ||
    ((isApplicationError(failure) || isControlError(failure)) && failure.code !== "unavailable") ||
    (isInboxError(failure) && failure.reason !== "unavailable")
  );
}
