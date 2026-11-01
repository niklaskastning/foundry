import {
  restoreDeviceSelection,
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
