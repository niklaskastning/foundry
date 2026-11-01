import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  type FoundryDeviceCatalog,
} from "@t3tools/contracts";
import { createDeviceCatalogClient, restoreDeviceSelection } from "./foundryCatalog.ts";

it("rechecks catalog identity, online status and permissions before selecting a gateway target", async () => {
  const binding = {
    origin: "https://main.example",
    issuer: "https://team.cloudflareaccess.com",
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    mainEnvironmentId: EnvironmentId.make("main"),
  };
  const deviceId = FoundryDeviceId.make("22222222-2222-4222-8222-222222222222");
  const device = {
    deviceId,
    environmentId: EnvironmentId.make("worker"),
    revoked: false,
    online: true,
    rpcReady: true,
    clientAccess: { enabled: true, generation: 1 },
  };
  let response: FoundryDeviceCatalog = {
    instanceId: binding.instanceId,
    canManage: false,
    scopes: ["orchestration:read", "access:write"],
    devices: [device],
  };
  const client = createDeviceCatalogClient({ binding, request: async () => response });
  const selection = JSON.stringify(await client.select(deviceId));
  expect(restoreDeviceSelection(selection, binding, binding.origin)?.[0]?.target.deviceId).toBe(
    deviceId,
  );
  expect(restoreDeviceSelection(null, binding, binding.origin)).toBeUndefined();
  expect(restoreDeviceSelection("null", binding, binding.origin)).toEqual([]);
  expect(restoreDeviceSelection("broken", binding, binding.origin)).toEqual([]);
  expect(restoreDeviceSelection(selection, null, binding.origin)).toEqual([]);
  expect(restoreDeviceSelection(selection, binding, "https://other.example")).toEqual([]);
  for (const changed of [
    { ...binding, issuer: "https://other.cloudflareaccess.com" },
    { ...binding, mainEnvironmentId: EnvironmentId.make("other") },
    { ...binding, instanceId: FoundryInstanceId.make("44444444-4444-4444-8444-444444444444") },
  ]) {
    expect(restoreDeviceSelection(selection, changed, binding.origin)).toEqual([]);
  }
  expect(await client.select(deviceId)).toMatchObject({
    binding,
    deviceId,
    environmentId: "worker",
    scopes: ["orchestration:read"],
  });
  for (const changed of [
    { ...device, online: false },
    { ...device, revoked: true },
    { ...device, rpcReady: false },
    { ...device, clientAccess: { enabled: false, generation: 2 } },
    { ...device, environmentId: binding.mainEnvironmentId },
  ]) {
    response = Object.assign({}, response, { devices: [changed] });
    await expect(client.select(deviceId)).rejects.toThrow();
  }
  response = { ...response, devices: [] };
  await expect(client.select(deviceId)).rejects.toThrow();
  response = { ...response, devices: [device], scopes: ["access:write"] };
  await expect(client.select(deviceId)).rejects.toThrow();
  response = {
    ...response,
    instanceId: FoundryInstanceId.make("33333333-3333-4333-8333-333333333333"),
  };
  await expect(client.load()).rejects.toThrow("identity");
});
