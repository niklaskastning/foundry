import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class AccessConfigurationError extends Schema.TaggedError<AccessConfigurationError>()(
  "AccessConfigurationError",
  {},
) {
  override get message() {
    return "Foundry Access requires PostgreSQL, a Cloudflare team HTTPS issuer, an application audience and an HTTPS public origin.";
  }
}
export class AccessEnabled extends Context.Reference<boolean>(
  "t3/foundry/AccessConfig/AccessEnabled",
  { defaultValue: () => false },
) {}
export class AccessConfig extends Context.Service<
  AccessConfig,
  {
    readonly issuer: string;
    readonly audience: string;
    readonly origin: string;
  }
>()("t3/foundry/AccessConfig") {}

const HttpsOrigin = Schema.String.check(Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/));
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const isOrigin = Schema.is(HttpsOrigin);
export const layer = Layer.effect(
  AccessConfig,
  Effect.gen(function* () {
    const issuer = yield* Config.String("FOUNDRY_ACCESS_ISSUER");
    const audience = yield* Config.String("FOUNDRY_ACCESS_AUDIENCE");
    const origin = yield* Config.String("FOUNDRY_PUBLIC_ORIGIN");
    const publicUrl = yield* decodeUrl(origin).pipe(
      Effect.mapError(() => new AccessConfigurationError({})),
    );
    if (
      !isOrigin(issuer) ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
      !isOrigin(origin) ||
      publicUrl.origin !== origin ||
      !audience.trim()
    ) {
      return yield* new AccessConfigurationError({});
    }
    return AccessConfig.of({ issuer, audience, origin });
  }),
);
