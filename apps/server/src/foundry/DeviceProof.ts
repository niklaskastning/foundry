// @effect-diagnostics nodeBuiltinImport:off -- Ed25519 key import/signature validation is the device protocol's crypto boundary.
import * as NodeCrypto from "node:crypto";
import {
  FoundryDeviceError,
  type FoundryEnrollment,
  type FoundryEnrollmentRequest,
} from "@t3tools/contracts";

function enrollmentPayload(enrollment: FoundryEnrollment): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "foundry-device-enrollment-v1",
      enrollment.instanceId,
      enrollment.origin,
      enrollment.environmentId,
      enrollment.publicKey,
      enrollment.token,
      enrollment.expiresAt,
    ]),
  );
}

export function verifyEnrollmentProof(request: FoundryEnrollmentRequest): boolean {
  try {
    const key = request.enrollment.publicKey;
    const bytes = Buffer.from(key, "base64url");
    const signature = Buffer.from(request.signature, "base64url");
    if (
      bytes.length !== 32 ||
      bytes.toString("base64url") !== key ||
      signature.length !== 64 ||
      signature.toString("base64url") !== request.signature
    )
      return false;
    return NodeCrypto.verify(
      null,
      enrollmentPayload(request.enrollment),
      NodeCrypto.createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: key },
        format: "jwk",
      }),
      signature,
    );
  } catch {
    return false;
  }
}

export function generateDeviceKey() {
  const pair = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ format: "jwk" }).x!,
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function signEnrollment(
  enrollment: FoundryEnrollment,
  privateKey: string,
): FoundryEnrollmentRequest {
  try {
    const key = NodeCrypto.createPrivateKey(privateKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      NodeCrypto.createPublicKey(key).export({ format: "jwk" }).x !== enrollment.publicKey
    )
      throw new Error("key mismatch");
    return {
      enrollment,
      signature: NodeCrypto.sign(null, enrollmentPayload(enrollment), key).toString("base64url"),
    };
  } catch {
    throw new FoundryDeviceError({ code: "invalid_proof" });
  }
}
