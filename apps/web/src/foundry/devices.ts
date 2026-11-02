import {
  createDeviceCatalogClient,
  ConnectionBlockedError,
  EnvironmentRegistry,
  FoundryOnboarding,
  type FoundryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type FoundryDeviceId,
  type FoundryDeviceCatalog,
  type FoundryEnrollment,
} from "@t3tools/contracts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { connectionAtomRuntime } from "../connection/runtime";
import { executeInstanceOperation, initialState } from "./onboarding";
import { readDeviceSelection, writeDeviceSelection } from "./selection";

type Operation =
  | { type: "load" }
  | { type: "select"; deviceId: FoundryDeviceId }
  | { type: "disconnect" }
  | { type: "approve"; environmentId: string; publicKey: string }
  | { type: "revoke"; deviceId: FoundryDeviceId }
  | { type: "access"; deviceId: FoundryDeviceId; generation: number; enabled: boolean };

async function client() {
  const state = await executeInstanceOperation({ operation: "session" });
  if (!state.binding || !state.session) throw new Error("Open Foundry instance sign-in first.");
  const binding = state.binding;
  return createDeviceCatalogClient({
    binding,
    request: async (operation, input) => {
      const descriptorResponse = await fetch(
        "/.well-known/foundry?protocolVersion=1&requiredCapability=foundry.device-catalog",
        { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      if (
        descriptorResponse.status === 400 &&
        descriptorResponse.headers.get("content-type")?.includes("application/json")
      )
        throw new Error("This Main does not support the device catalog yet.");
      const descriptor = await FoundryOnboarding.readResponse(descriptorResponse);
      const verified = FoundryOnboarding.verifyDescriptor(
        descriptor,
        window.location.origin,
        binding,
      );
      if (!verified.descriptor.capabilities.includes("foundry.device-catalog"))
        throw new Error("This Main does not support the device catalog yet.");
      const current = await executeInstanceOperation({ operation: "session", candidate: binding });
      if (!current.session) throw new Error("Sign in to Foundry again.");
      const response = await fetch(`/api/foundry/gateway/grants/${operation}`, {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Foundry-CSRF": current.session.csrfToken,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      });
      if (
        response.status === 403 &&
        response.headers.get("content-type")?.includes("application/json")
      )
        throw new Error(
          "Access denied. A Main T3 session and the required device permissions are needed in addition to Foundry sign-in. Device pairing is not required.",
        );
      if (
        response.status === 503 &&
        response.headers.get("content-type")?.includes("application/json")
      )
        throw new Error(
          "The device registry is temporarily unavailable. Retry after Main recovers.",
        );
      const result = await FoundryOnboarding.readResponse(response);
      const saved = initialState().binding;
      if (
        saved?.instanceId !== binding.instanceId ||
        saved.origin !== binding.origin ||
        saved.issuer !== binding.issuer ||
        saved.mainEnvironmentId !== binding.mainEnvironmentId
      )
        throw new FoundryOnboarding.OnboardingError("identity");
      return result;
    },
  });
}

export const deviceCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "foundry:devices",
  concurrency: { mode: "serial", key: () => "foundry-devices" },
  execute: Effect.fn("FoundryDevices.execute")(function* (input: Operation) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const run = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({
        try: f,
        catch: (error) =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: error instanceof Error ? error.message : "Device operation failed.",
          }),
      });
    let target: FoundryConnectionTarget | null | undefined;
    let enrollment: FoundryEnrollment | undefined;
    let catalog: FoundryDeviceCatalog | undefined;
    if (input.type === "disconnect") target = null;
    else {
      const service = yield* run(client);
      switch (input.type) {
        case "load":
          catalog = yield* run(service.load);
          break;
        case "select":
          target = yield* run(() => service.select(input.deviceId));
          break;
        case "approve":
          enrollment = yield* run(() => service.approve(input));
          break;
        case "revoke":
          yield* run(() => service.revoke(input.deviceId));
          break;
        case "access":
          yield* run(() =>
            service.access({
              deviceId: input.deviceId,
              kind: "clientAccess",
              enabled: input.enabled,
              generation: input.generation,
            }),
          );
          break;
      }
      catalog ??= yield* run(service.load);
      const selected = readDeviceSelection()?.[0]?.target;
      if (
        selected?._tag === "FoundryConnectionTarget" &&
        !catalog.devices.some(
          (device) =>
            device.deviceId === selected.deviceId && !device.revoked && device.clientAccess.enabled,
        )
      )
        target = null;
    }
    if (target !== undefined) {
      const entries = yield* SubscriptionRef.get(registry.entries);
      const existing = target ? entries.get(target.environmentId) : undefined;
      if (existing && existing.target._tag !== "FoundryConnectionTarget")
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail:
            "This environment already has a personal T3 connection. It will not be replaced by Foundry.",
        });
      yield* Effect.try({
        try: () => writeDeviceSelection(target ?? null),
        catch: () =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "Device selection could not be saved.",
          }),
      });
      const selection = readDeviceSelection();
      if (selection !== undefined) yield* registry.reconcilePlatform(selection);
      if (target) {
        const installed = (yield* SubscriptionRef.get(registry.entries)).get(
          target.environmentId,
        )?.target;
        if (
          installed?._tag !== "FoundryConnectionTarget" ||
          installed.deviceId !== target.deviceId
        ) {
          yield* Effect.sync(() => writeDeviceSelection(null));
          yield* registry.reconcilePlatform([]);
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail:
              "This device could not be installed without replacing an existing connection. Disconnect it explicitly before retrying.",
          });
        }
      }
    }
    return { catalog, enrollment };
  }),
});
