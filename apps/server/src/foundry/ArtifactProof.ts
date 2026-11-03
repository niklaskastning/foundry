// @effect-diagnostics nodeBuiltinImport:off -- Ed25519 signs the bounded artifact envelope with the existing dedicated device key.
import * as NodeCrypto from "node:crypto";
import type {
  FoundryArtifactMachineRequest,
  FoundryArtifactRequest,
  FoundryDevice,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

const payload = (origin: string, value: Omit<FoundryArtifactMachineRequest, "signature">) =>
  new TextEncoder().encode(
    stableStringify([
      "foundry-artifact-transfer-v1",
      origin,
      value.protocolVersion,
      value.instanceId,
      value.deviceId,
      value.environmentId,
      value.generation,
      value.issuedAt,
      value.request,
    ]),
  );
export function signArtifactRequest(
  origin: string,
  device: FoundryDevice,
  issuedAt: number,
  request: FoundryArtifactRequest,
  privateKey: string,
): FoundryArtifactMachineRequest {
  const input = {
    protocolVersion: "1" as const,
    instanceId: device.instanceId,
    deviceId: device.deviceId,
    environmentId: device.environmentId,
    generation: device.generation,
    issuedAt,
    request,
  };
  return {
    ...input,
    signature: NodeCrypto.sign(
      null,
      payload(origin, input),
      NodeCrypto.createPrivateKey(privateKey),
    ).toString("base64url"),
  };
}
export function verifyArtifactRequest(
  origin: string,
  input: FoundryArtifactMachineRequest,
  publicKey: string,
): boolean {
  try {
    const signature = Buffer.from(input.signature, "base64url");
    return (
      signature.length === 64 &&
      signature.toString("base64url") === input.signature &&
      NodeCrypto.verify(
        null,
        payload(origin, input),
        NodeCrypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: publicKey },
          format: "jwk",
        }),
        signature,
      )
    );
  } catch {
    return false;
  }
}
