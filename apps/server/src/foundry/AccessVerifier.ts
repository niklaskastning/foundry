import * as DateTime from "effect/DateTime";
import { FoundryAuthError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import * as AccessConfig from "./AccessConfig.ts";

const decodeClaims = Schema.decodeUnknownEffect(
  Schema.Struct({
    sub: Schema.String.check(Schema.isMinLength(1)),
    exp: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    iat: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    type: Schema.Literal("app"),
  }),
);

export class AccessSigningKeys extends Context.Service<AccessSigningKeys, JWTVerifyGetKey>()(
  "t3/foundry/AccessVerifier/AccessSigningKeys",
) {}
export const layerRemoteKeys = Layer.effect(
  AccessSigningKeys,
  Effect.gen(function* () {
    const config = yield* AccessConfig.AccessConfig;
    return createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      cacheMaxAge: 300000,
      cooldownDuration: 30000,
    });
  }),
);

export class AccessVerifier extends Context.Service<
  AccessVerifier,
  {
    readonly verify: (
      assertion: string | undefined,
    ) => Effect.Effect<
      { readonly issuer: string; readonly subject: string; readonly expiresAt: number },
      FoundryAuthError
    >;
  }
>()("t3/foundry/AccessVerifier") {}

const make = Effect.gen(function* () {
  const config = yield* AccessConfig.AccessConfig;
  const keys = yield* AccessSigningKeys;
  const verify = Effect.fn("AccessVerifier.verify")(function* (assertion: string | undefined) {
    if (!assertion || assertion.length > 16384)
      return yield* new FoundryAuthError({ code: "invalid_access" });
    const now = yield* Clock.currentTimeMillis;
    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(assertion, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256"],
          requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
        }),
      catch: (error) =>
        new FoundryAuthError({
          code:
            error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)
              ? "invalid_access"
              : "unavailable",
        }),
    });
    const claims = yield* decodeClaims(payload).pipe(
      Effect.mapError(() => new FoundryAuthError({ code: "invalid_access" })),
    );
    if (claims.iat > now / 1000 || claims.exp <= now / 1000) {
      return yield* new FoundryAuthError({ code: "invalid_access" });
    }
    return { issuer: config.issuer, subject: claims.sub, expiresAt: claims.exp * 1000 };
  });
  return AccessVerifier.of({ verify });
});
export const layer = Layer.effect(AccessVerifier, make);
