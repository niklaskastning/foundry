import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  type FoundryDeviceCatalog,
} from "@t3tools/contracts";
import {
  authorizedDeviceRegistrations,
  createDeviceCatalogClient,
  restoreDeviceSelection,
  resolveDevicePlatformRegistrations,
} from "./foundryCatalog.ts";
import {
  PrimaryConnectionRegistration,
  FoundryConnectionRegistration,
  BearerConnectionRegistration,
  BearerConnectionProfile,
  BearerConnectionCredential,
} from "./catalog.ts";
import {
  PrimaryConnectionTarget,
  FoundryConnectionTarget,
  BearerConnectionTarget,
} from "./model.ts";

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
  const offline = {
    ...device,
    online: false,
    rpcReady: false,
    environmentId: EnvironmentId.make("offline"),
    deviceId: FoundryDeviceId.make("44444444-4444-4444-8444-444444444444"),
  };
  const discovered = authorizedDeviceRegistrations(
    {
      ...response,
      devices: [
        device,
        offline,
        { ...device, revoked: true },
        { ...device, clientAccess: { enabled: false, generation: 1 } },
      ],
    },
    binding,
  );
  expect(discovered.map((entry) => entry.target.environmentId)).toEqual(["worker", "offline"]);
  expect(
    restoreDeviceSelection(
      JSON.stringify(discovered.map((entry) => entry.target)),
      binding,
      binding.origin,
    )?.map((entry) => entry.target.environmentId),
  ).toEqual(["worker", "main", "offline"]);
  const client = createDeviceCatalogClient({ binding, request: async () => response });
  const selection = JSON.stringify(await client.select(deviceId));
  expect(restoreDeviceSelection(selection, binding, binding.origin)?.[0]?.target).toMatchObject({
    deviceId,
  });
  expect(restoreDeviceSelection(selection, binding, binding.origin)).toMatchObject([
    { _tag: "FoundryConnectionRegistration", target: { environmentId: "worker" } },
    {
      _tag: "PrimaryConnectionRegistration",
      target: {
        _tag: "PrimaryConnectionTarget",
        environmentId: "main",
        httpBaseUrl: "https://main.example/",
        wsBaseUrl: "wss://main.example/",
      },
    },
  ]);
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

it("keeps only the confirmed Main control connection when a selected sandbox is disconnected or restored", () => {
  const binding = {
    origin: "https://main.example",
    issuer: "https://team.cloudflareaccess.com",
    instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
    mainEnvironmentId: EnvironmentId.make("main"),
  };
  const main = new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: binding.mainEnvironmentId,
      label: "Foundry Main",
      httpBaseUrl: binding.origin + "/",
      wsBaseUrl: "wss://main.example/",
    }),
  });
  const personal = new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("personal"),
      label: "Desktop",
      httpBaseUrl: "http://localhost:3000/",
      wsBaseUrl: "ws://localhost:3000/",
    }),
  });
  const secondary = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make("secondary"),
      label: "Other local",
      connectionId: "secondary",
    }),
    profile: new BearerConnectionProfile({
      environmentId: EnvironmentId.make("secondary"),
      label: "Other local",
      connectionId: "secondary",
      httpBaseUrl: "http://localhost:3001/",
      wsBaseUrl: "ws://localhost:3001/",
    }),
    credential: new BearerConnectionCredential({ token: "fixture" }),
  });
  const sandbox = new FoundryConnectionRegistration({
    target: new FoundryConnectionTarget({
      binding,
      deviceId: FoundryDeviceId.make("22222222-2222-4222-8222-222222222222"),
      environmentId: EnvironmentId.make("sandbox"),
      label: "Sandbox",
      scopes: ["orchestration:read"],
    }),
  });
  const available = [personal, secondary, main];
  const selected = restoreDeviceSelection(JSON.stringify(sandbox.target), binding, binding.origin);
  const disconnected = restoreDeviceSelection("null", binding, binding.origin);
  expect(
    resolveDevicePlatformRegistrations(disconnected, available, binding, binding.origin),
  ).toEqual([main]);
  expect(resolveDevicePlatformRegistrations(selected, available, binding, binding.origin)).toEqual([
    sandbox,
    main,
  ]);
  expect(resolveDevicePlatformRegistrations([], available, binding, binding.origin)).toEqual([
    main,
  ]);
  expect(resolveDevicePlatformRegistrations(undefined, available, binding, binding.origin)).toBe(
    available,
  );
  expect(
    resolveDevicePlatformRegistrations(selected, [personal, secondary], binding, binding.origin),
  ).toEqual([sandbox, main]);
  expect(resolveDevicePlatformRegistrations(selected, available, null, binding.origin)).toEqual([]);
  expect(
    resolveDevicePlatformRegistrations(selected, available, binding, "https://other.example"),
  ).toEqual([]);
  for (const wrong of [
    { ...main.target, environmentId: personal.target.environmentId },
    { ...main.target, httpBaseUrl: "https://other.example/" },
    { ...main.target, wsBaseUrl: "wss://other.example/" },
    { ...main.target, httpBaseUrl: "https://user:password@main.example/" },
  ]) {
    expect(
      resolveDevicePlatformRegistrations(
        [],
        [new PrimaryConnectionRegistration({ target: new PrimaryConnectionTarget(wrong) })],
        binding,
        binding.origin,
      ),
    ).toEqual([main]);
  }
  expect(
    resolveDevicePlatformRegistrations(
      [sandbox],
      available,
      { ...binding, issuer: "https://other.cloudflareaccess.com" },
      binding.origin,
    ),
  ).toEqual([main]);
  expect(
    resolveDevicePlatformRegistrations(
      [],
      [],
      { ...binding, origin: "https://main.example/path" },
      "https://main.example/path",
    ),
  ).toEqual([]);
  expect(
    resolveDevicePlatformRegistrations(
      [],
      available,
      { ...binding, issuer: "broken" },
      binding.origin,
    ),
  ).toEqual([]);
});
