import {
  restoreDeviceSelection,
  resolveDevicePlatformRegistrations,
  type FoundryConnectionTarget,
  type PlatformConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { initialState } from "./onboarding";

const key = "foundry:selected-device:v1";

export function readDeviceSelection(): ReadonlyArray<PlatformConnectionRegistration> | undefined {
  try {
    return restoreDeviceSelection(
      sessionStorage.getItem(key),
      initialState().binding,
      window.location.origin,
    );
  } catch {
    return [];
  }
}

export function writeDeviceSelection(target: FoundryConnectionTarget | null) {
  if (target === null && sessionStorage.getItem(key) === null) return;
  sessionStorage.setItem(key, JSON.stringify(target));
}

export function devicePlatformRegistrations(
  available: ReadonlyArray<PlatformConnectionRegistration>,
) {
  return resolveDevicePlatformRegistrations(
    readDeviceSelection(),
    available,
    initialState().binding,
    window.location.origin,
  );
}

export function writeDeviceRegistrations(
  registrations: ReadonlyArray<PlatformConnectionRegistration>,
) {
  sessionStorage.setItem(
    key,
    JSON.stringify(
      registrations
        .filter((entry) => entry._tag === "FoundryConnectionRegistration")
        .map((entry) => entry.target),
    ),
  );
}
