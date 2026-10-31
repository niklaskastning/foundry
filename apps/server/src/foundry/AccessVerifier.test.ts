import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as AccessConfig from "./AccessConfig.ts";
import * as AccessVerifier from "./AccessVerifier.ts";

const config = {
  issuer: "https://fixture.cloudflareaccess.com",
  audience: "fixture-app",
  origin: "https://foundry.example.test",
};
it.effect("accepts only signed application assertions for the configured issuer and audience", () =>
  Effect.gen(function* () {
    const keys = yield* Effect.promise(() => generateKeyPair("RS256"));
    const foreignKeys = yield* Effect.promise(() => generateKeyPair("RS256"));
    const jwk = yield* Effect.promise(() => exportJWK(keys.publicKey));
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const claims = {
      iss: config.issuer,
      aud: config.audience,
      sub: "operator-subject",
      iat: now,
      exp: now + 600,
      type: "app",
    };
    const sign = (payload: Record<string, unknown>, key = keys.privateKey) =>
      Effect.promise(() =>
        new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(key),
      );
    yield* Effect.gen(function* () {
      const verifier = yield* AccessVerifier.AccessVerifier;
      expect(yield* verifier.verify(yield* sign(claims))).toEqual({
        issuer: config.issuer,
        subject: claims.sub,
        expiresAt: claims.exp * 1000,
      });
      for (const payload of [
        { ...claims, iss: "https://foreign.cloudflareaccess.com" },
        { ...claims, aud: "foreign-app" },
        { ...claims, sub: "" },
        { ...claims, sub: 42 },
        { ...claims, exp: now - 1 },
        { ...claims, iat: now + 600 },
        { ...claims, nbf: now + 600 },
        { ...claims, type: "service" },
        { iss: config.issuer, aud: config.audience, sub: claims.sub, iat: now, type: "app" },
      ]) {
        expect((yield* Effect.flip(verifier.verify(yield* sign(payload)))).code).toBe(
          "invalid_access",
        );
      }
      for (const token of [undefined, "malformed", yield* sign(claims, foreignKeys.privateKey)]) {
        expect((yield* Effect.flip(verifier.verify(token))).code).toBe("invalid_access");
      }
    }).pipe(
      Effect.provide(
        AccessVerifier.layer.pipe(
          Layer.provide(
            Layer.succeed(
              AccessVerifier.AccessSigningKeys,
              createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] }),
            ),
          ),
          Layer.provide(Layer.succeed(AccessConfig.AccessConfig, config)),
        ),
      ),
    );
  }),
);

it.effect("fails closed when signing keys cannot be fetched", () =>
  Effect.gen(function* () {
    const keys = yield* Effect.promise(() => generateKeyPair("RS256"));
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const token = yield* Effect.promise(() =>
      new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setSubject("operator-subject")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(keys.privateKey),
    );
    const error = yield* AccessVerifier.AccessVerifier.pipe(
      Effect.flatMap((verifier) => verifier.verify(token)),
      Effect.flip,
      Effect.provide(
        AccessVerifier.layer.pipe(
          Layer.provide(
            Layer.succeed(AccessVerifier.AccessSigningKeys, () =>
              Promise.reject(new Error("offline fixture")),
            ),
          ),
          Layer.provide(Layer.succeed(AccessConfig.AccessConfig, config)),
        ),
      ),
    );
    expect(error.code).toBe("unavailable");
  }),
);
