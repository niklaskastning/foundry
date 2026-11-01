import { FoundryOnboarding, ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { appAtomRuntime } from "../lib/runtime";

export type Operation = FoundryOnboarding.Operation;
export type OnboardingResult = FoundryOnboarding.OnboardingResult;

async function request(path: string, csrf?: string) {
  const response = await fetch(path, {
    method: path.startsWith("/api/foundry/auth/") ? "POST" : "GET",
    credentials: "same-origin",
    redirect: "manual",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Foundry-CSRF": csrf } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  return FoundryOnboarding.readResponse(response);
}

export const instanceCommand = createRuntimeCommand(appAtomRuntime, {
  label: "foundry:instance-onboarding",
  concurrency: { mode: "serial", key: () => "active-instance" },
  execute: (input: { operation: Operation; candidate?: FoundryOnboarding.InstanceBinding }) =>
    Effect.tryPromise({
      try: () =>
        FoundryOnboarding.createInstanceClient({
          origin: window.location.origin,
          storage: localStorage,
          now: Date.now,
          request,
        }).execute(input.operation, input.candidate),
      catch: (error) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: FoundryOnboarding.errorMessage(error),
        }),
    }),
});

export function instanceEntry(raw: string): string {
  return `${FoundryOnboarding.normalizeOrigin(raw, import.meta.env.DEV)}/foundry`;
}

export function initialState(): OnboardingResult {
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
  if (client.readBinding()) await client.execute("inspect");
}
