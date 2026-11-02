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
import { type InstanceBinding, OnboardingError } from "./foundry.ts";
import { FoundryConnectionTarget } from "./model.ts";
import { FoundryConnectionRegistration } from "./catalog.ts";

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
    return [new FoundryConnectionRegistration({ target })];
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
