import { isNativeOrigin } from "./AccessConfig.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FoundryDeviceError } from "@t3tools/contracts";

export class DeviceEnrollmentEnabled extends Context.Reference<boolean>(
  "t3/foundry/DeviceEnrollmentEnabled",
  { defaultValue: () => false },
) {}
export class DeviceChannelEnabled extends Context.Reference<boolean>(
  "t3/foundry/DeviceConfig/DeviceChannelEnabled",
  { defaultValue: () => false },
) {}
export class HttpGatewayEnabled extends Context.Reference<boolean>(
  "t3/foundry/HttpGatewayEnabled",
  { defaultValue: () => false },
) {}
export class StreamGatewayEnabled extends Context.Reference<boolean>(
  "t3/foundry/StreamGatewayEnabled",
  { defaultValue: () => false },
) {}
export class ArtifactsEnabled extends Context.Reference<boolean>(
  "t3/foundry/DeviceConfig/ArtifactsEnabled",
  { defaultValue: () => false },
) {}
export class DeviceOrigin extends Context.Service<DeviceOrigin, { readonly origin: string }>()(
  "t3/foundry/DeviceConfig/DeviceOrigin",
) {}
export const layer = Layer.effect(
  DeviceOrigin,
  Effect.gen(function* () {
    const origin = yield* Config.String("FOUNDRY_PUBLIC_ORIGIN");
    const mode = yield* Config.String("FOUNDRY_AUTH_MODE").pipe(Config.withDefault("access"));
    const valid =
      mode === "native"
        ? isNativeOrigin(origin)
        : URL.canParse(origin) &&
          new URL(origin).origin === origin &&
          new URL(origin).protocol === "https:";
    if (!valid) return yield* new FoundryDeviceError({ code: "configuration" });
    return { origin };
  }),
);
