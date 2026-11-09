import { FoundryAuthError, FoundryDeviceCatalog } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  FoundryOnboarding,
  ConnectionBlockedError,
  authorizedDeviceRegistrations,
} from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { appAtomRuntime } from "../lib/runtime";

const decodeCatalog = Schema.decodeUnknownSync(FoundryDeviceCatalog);
const isAuthError = Schema.is(FoundryAuthError);

export type Operation = FoundryOnboarding.Operation;
export type OnboardingResult = FoundryOnboarding.OnboardingResult;

async function request(
  path: string,
  csrf?: string,
  credentials?: { username: string; password: string },
) {
  const response = await fetch(path, {
    method: path.startsWith("/api/foundry/auth/") ? "POST" : "GET",
    credentials: "same-origin",
    redirect: "manual",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Foundry-CSRF": csrf } : {}) },
    ...(credentials ? { body: JSON.stringify(credentials) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return FoundryOnboarding.readResponse(response);
}

let originMismatch: { current: string; configured: string } | undefined;
export const instanceOriginMismatch = () => originMismatch;

export async function executeInstanceOperation(input: {
  operation: Operation;
  candidate?: FoundryOnboarding.InstanceBinding;
  credentials?: { username: string; password: string };
}) {
  if (!navigator.locks) throw new FoundryOnboarding.OnboardingError("coordination");
  // Foundry cookies are shared across tabs, so a per-tab command queue cannot serialize renewal.
  const signal = AbortSignal.timeout(15000);
  let acquired = false;
  try {
    return await navigator.locks.request("foundry:instance-session:v1", { signal }, () => {
      acquired = true;
      return FoundryOnboarding.createInstanceClient({
        origin: window.location.origin,
        storage: localStorage,
        now: Date.now,
        request: (path, csrf) =>
          request(path, csrf, path.endsWith("/login") ? input.credentials : undefined),
      })
        .execute(input.operation, input.candidate)
        .then((result) => {
          sessionState = result;
          window.dispatchEvent(new Event("foundry:session"));
          return result;
        });
    });
  } catch (error) {
    originMismatch =
      error instanceof FoundryOnboarding.OnboardingError ? error.originMismatch : undefined;
    sessionState =
      input.operation === "login" &&
      isAuthError(error) &&
      error.code === "invalid_access" &&
      sessionState
        ? { ...sessionState, session: null }
        : undefined;
    window.dispatchEvent(new Event("foundry:session"));
    if (!acquired && signal.aborted)
      throw new FoundryOnboarding.OnboardingError("coordination_busy");
    throw error;
  }
}

export const instanceCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:instance-onboarding",
  concurrency: { mode: "serial", key: () => "active-instance" },
  execute: (input: {
    operation: Operation;
    candidate?: FoundryOnboarding.InstanceBinding;
    credentials?: { username: string; password: string };
  }) =>
    Effect.tryPromise({
      try: () => executeInstanceOperation(input),
      catch: (error) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: FoundryOnboarding.errorMessage(error),
        }),
    }),
});

export function instanceEntry(raw: string): string {
  return `${FoundryOnboarding.normalizeOrigin(raw, true)}/foundry`;
}

let sessionState: OnboardingResult | undefined;
export function initialState(): OnboardingResult {
  if (sessionState)
    return {
      ...sessionState,
      session:
        sessionState.session && sessionState.session.expiresAt > Date.now()
          ? sessionState.session
          : null,
    };
  try {
    const binding = FoundryOnboarding.createInstanceClient({
      origin: window.location.origin,
      storage: localStorage,
      now: Date.now,
      request,
    }).readBinding();
    return {
      binding: binding ?? null,
      confirmed: Boolean(binding),
      session: null,
      message: binding
        ? "Saved identity loaded. Verify it before continuing."
        : "Verify this instance to begin, or enter another instance URL.",
    };
  } catch {
    return {
      binding: null,
      confirmed: true,
      session: null,
      message:
        "Saved identity is unreadable. Access is blocked; explicitly forget it only after operator verification.",
    };
  }
}

export async function verifySavedInstance(): Promise<void> {
  const client = FoundryOnboarding.createInstanceClient({
    origin: window.location.origin,
    storage: localStorage,
    now: Date.now,
    request,
  });
  if (client.readBinding()) {
    const state = await executeInstanceOperation({ operation: "session" });
    if (state.binding && state.session && state.devicesAvailable) {
      const response = await fetch("/api/foundry/gateway/grants/catalog", {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Foundry-CSRF": state.session.csrfToken },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      const catalog = decodeCatalog(await FoundryOnboarding.readResponse(response));
      const { writeDeviceRegistrations } = await import("./selection");
      writeDeviceRegistrations(authorizedDeviceRegistrations(catalog, state.binding));
    }
  }
}
