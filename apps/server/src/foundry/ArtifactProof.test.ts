import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  type FoundryDevice,
} from "@t3tools/contracts";
import { generateDeviceKey } from "./DeviceProof.ts";
import { signArtifactRequest, verifyArtifactRequest } from "./ArtifactProof.ts";

it("binds the complete artifact operation to the origin and registered device generation", () => {
  const key = generateDeviceKey();
  const other = generateDeviceKey();
  const device: FoundryDevice = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("artifact-worker"),
    publicKey: key.publicKey,
    generation: 1,
    revoked: false,
  };
  const origin = "https://main.example.test";
  const proof = signArtifactRequest(
    origin,
    device,
    1000,
    { op: "list", input: {} },
    key.privateKey,
  );
  expect(verifyArtifactRequest(origin, proof, key.publicKey)).toBe(true);
  expect(verifyArtifactRequest(origin, proof, other.publicKey)).toBe(false);
  expect(verifyArtifactRequest("https://foreign.example.test", proof, key.publicKey)).toBe(false);
  for (const changed of [
    { ...proof, generation: 2 },
    { ...proof, issuedAt: 1001 },
    { ...proof, instanceId: FoundryInstanceId.make("33333333-3333-4333-8333-333333333333") },
    { ...proof, deviceId: FoundryDeviceId.make("44444444-4444-4444-8444-444444444444") },
    { ...proof, environmentId: EnvironmentId.make("foreign-worker") },
    { ...proof, request: { op: "list" as const, input: { before: "10" } } },
    { ...proof, signature: proof.signature.slice(1) },
  ])
    expect(verifyArtifactRequest(origin, changed, key.publicKey)).toBe(false);
});
