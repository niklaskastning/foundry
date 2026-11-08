// @effect-diagnostics nodeBuiltinImport:off -- Ed25519 signs the bounded artifact envelope with the existing dedicated device key.
import * as NodeCrypto from "node:crypto";
import {
  type FoundryArchiveMachineRequest,
  FoundryArchiveRequest,
  type FoundryDevice,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { stableStringify } from "@t3tools/shared/relaySigning";

const encodeRequest = Schema.encodeSync(FoundryArchiveRequest);
const payload = (origin: string, value: Omit<FoundryArchiveMachineRequest, "signature">) =>
  new TextEncoder().encode(
    stableStringify([
      "foundry-thread-archive-v1",
      origin,
      value.protocolVersion,
      value.instanceId,
      value.deviceId,
      value.environmentId,
      value.generation,
      value.issuedAt,
      encodeRequest(value.request),
    ]),
  );
export function signArchiveRequest(
  origin: string,
  device: FoundryDevice,
  issuedAt: number,
  request: FoundryArchiveRequest,
  privateKey: string,
): FoundryArchiveMachineRequest {
  const input = {
    protocolVersion: "archive-1" as const,
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
export function verifyArchiveRequest(
  origin: string,
  input: FoundryArchiveMachineRequest,
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
