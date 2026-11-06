// @effect-diagnostics nodeBuiltinImport:off -- Existing device keys sign a distinct credential-issuance audience.
import * as NodeCrypto from "node:crypto";
import type {
  FoundryDevice,
  FoundryProviderIssue,
  FoundryProviderMachineRequest,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

const payload = (origin: string, input: Omit<FoundryProviderMachineRequest, "signature">) =>
  new TextEncoder().encode(
    stableStringify([
      "foundry-provider-connection-v1",
      origin,
      input.protocolVersion,
      input.instanceId,
      input.deviceId,
      input.environmentId,
      input.generation,
      input.issuedAt,
      input.request,
    ]),
  );

export function signProviderRequest(
  origin: string,
  device: FoundryDevice,
  issuedAt: number,
  request: FoundryProviderIssue,
  privateKey: string,
): FoundryProviderMachineRequest {
  const input = {
    protocolVersion: "provider-1" as const,
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

export function verifyProviderRequest(
  origin: string,
  input: FoundryProviderMachineRequest,
  publicKey: string,
) {
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
