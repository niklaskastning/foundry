import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundryProviderMachineRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { generateDeviceKey } from "./DeviceProof.ts";
import { signProviderRequest, verifyProviderRequest } from "./ProviderConnectionProof.ts";

it("binds credential issuance to device, central origin, allocation, factory and connection revision", () => {
  const key = generateDeviceKey();
  const device = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("sandbox-a"),
    generation: 1,
    revoked: false,
    publicKey: key.publicKey,
  };
  const request = {
    connectionId: "central-codex",
    connectionGeneration: 1,
    allocationId: "allocation-a",
    factoryId: "factory-a",
  };
  const origin = "https://main.example.test";
  const proof = signProviderRequest(origin, device, 1000, request, key.privateKey);
  const codec = Schema.fromJsonString(FoundryProviderMachineRequest);
  const received = Schema.decodeSync(codec)(Schema.encodeSync(codec)(proof));
  expect(verifyProviderRequest(origin, received, key.publicKey)).toBe(true);
  expect(verifyProviderRequest("https://other.example.test", received, key.publicKey)).toBe(false);
  expect(verifyProviderRequest(origin, received, generateDeviceKey().publicKey)).toBe(false);
  for (const changed of [
    { ...received, issuedAt: 1001 },
    { ...received, generation: 2 },
    { ...received, environmentId: EnvironmentId.make("sandbox-b") },
    { ...received, request: { ...request, connectionId: "other" } },
    { ...received, request: { ...request, connectionGeneration: 2 } },
    { ...received, request: { ...request, allocationId: "allocation-b" } },
    { ...received, request: { ...request, factoryId: null } },
    { ...received, signature: received.signature.slice(1) },
  ])
    expect(verifyProviderRequest(origin, changed, key.publicKey)).toBe(false);
});
