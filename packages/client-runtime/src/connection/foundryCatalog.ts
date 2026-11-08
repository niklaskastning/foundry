import {
  FoundryDeviceCatalog,
  FoundryDeviceApproval,
  FoundryEnrollment,
  FoundryDeviceGrant,
  FoundryDeviceGrantUpdate,
  FoundryGatewayGrantRequest,
  type FoundryDeviceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type InstanceBinding, OnboardingError, normalizeOrigin } from "./foundry.ts";
import { FoundryConnectionTarget, PrimaryConnectionTarget } from "./model.ts";
import {
  FoundryConnectionRegistration,
  PrimaryConnectionRegistration,
  type PlatformConnectionRegistration,
} from "./catalog.ts";

const decodeCatalog = Schema.decodeUnknownSync(FoundryDeviceCatalog);
const decodeTarget = Schema.decodeUnknownSync(FoundryGatewayGrantRequest);
const decodeApproval = Schema.decodeUnknownSync(FoundryDeviceApproval);
const decodeEnrollment = Schema.decodeUnknownSync(FoundryEnrollment);
const decodeGrant = Schema.decodeUnknownSync(FoundryDeviceGrant);
const decodeUpdate = Schema.decodeUnknownSync(FoundryDeviceGrantUpdate);
const isScopes = Schema.is(FoundryGatewayGrantRequest.fields.scopes);
const decodeSelection = Schema.decodeUnknownSync(FoundryConnectionTarget);

export function restoreDeviceSelection(
  raw: string | null,
  binding: InstanceBinding | null,
  origin: string,
) {
  if (raw === null) return undefined;
  if (raw === "null") return [];
  try {
    const target = decodeSelection(JSON.parse(raw));
    if (
      !binding ||
      binding.origin !== origin ||
      binding.origin !== target.binding.origin ||
      binding.issuer !== target.binding.issuer ||
      binding.instanceId !== target.binding.instanceId ||
      binding.mainEnvironmentId !== target.binding.mainEnvironmentId ||
      target.environmentId === binding.mainEnvironmentId
    )
      return [];
    const main = confirmedMainRegistration(binding, origin);
    return main ? ([new FoundryConnectionRegistration({ target }), main] as const) : [];
  } catch {
    return [];
  }
}

export function createDeviceCatalogClient(options: {
  binding: InstanceBinding;
  request: (operation: string, input: unknown) => Promise<unknown>;
}) {
  async function load() {
    const catalog = decodeCatalog(await options.request("catalog", {}));
    if (catalog.instanceId !== options.binding.instanceId) throw new OnboardingError("identity");
    return catalog;
  }
  return {
    load,
    async select(deviceId: FoundryDeviceId) {
      const catalog = await load();
      const device = catalog.devices.find((entry) => entry.deviceId === deviceId);
      if (
        !device ||
        device.revoked ||
        !device.online ||
        !device.rpcReady ||
        !device.clientAccess.enabled
      )
        throw new Error(
          "This device is offline, revoked, or unavailable for client access. Refresh the device list.",
        );
      if (device.environmentId === options.binding.mainEnvironmentId)
        throw new OnboardingError("identity");
      const scopes = catalog.scopes.filter((scope) => isScopes([scope]));
      const target = decodeTarget({ deviceId, environmentId: device.environmentId, scopes });
      if (!target.scopes.includes("orchestration:read"))
        throw new Error("This Main session cannot read projects.");
      return new FoundryConnectionTarget({
        ...target,
        binding: options.binding,
        label: `Device ${device.environmentId}`,
      });
    },
    async approve(input: unknown) {
      const approval = decodeApproval(input);
      const result = decodeEnrollment(await options.request("approveDevice", approval));
      if (
        result.instanceId !== options.binding.instanceId ||
        result.origin !== options.binding.origin ||
        result.environmentId !== approval.environmentId ||
        result.publicKey !== approval.publicKey
      )
        throw new OnboardingError("identity");
      return result;
    },
    async revoke(deviceId: FoundryDeviceId) {
      await options.request("revokeDevice", { deviceId });
    },
    async access(input: unknown) {
      return decodeGrant(await options.request("updateAccess", decodeUpdate(input)));
    },
  };
}

export function resolveDevicePlatformRegistrations(
  selection: ReadonlyArray<PlatformConnectionRegistration> | undefined,
  available: ReadonlyArray<PlatformConnectionRegistration>,
  binding: InstanceBinding | null,
  origin: string,
): ReadonlyArray<PlatformConnectionRegistration> {
  if (selection === undefined) return available;
  const main = confirmedMainRegistration(binding, origin);
  if (!binding || !main) return [];
  const selected = selection.filter((registration) => {
    if (registration._tag !== "FoundryConnectionRegistration") return false;
    const target = registration.target;
    return (
      target.environmentId !== binding.mainEnvironmentId &&
      target.binding.origin === binding.origin &&
      target.binding.issuer === binding.issuer &&
      target.binding.instanceId === binding.instanceId &&
      target.binding.mainEnvironmentId === binding.mainEnvironmentId
    );
  });
  return [...selected, main];
}

function confirmedMainRegistration(binding: InstanceBinding | null, origin: string) {
  if (!binding || binding.origin !== origin) return undefined;
  try {
    if (
      normalizeOrigin(binding.origin, true) !== origin ||
      normalizeOrigin(binding.issuer) !== binding.issuer
    )
      return undefined;
    const url = new URL(binding.origin);
    const httpBaseUrl = url.toString();
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: binding.mainEnvironmentId,
        label: "Foundry Main",
        httpBaseUrl,
        wsBaseUrl: url.toString(),
      }),
    });
  } catch {
    return undefined;
  }
}
