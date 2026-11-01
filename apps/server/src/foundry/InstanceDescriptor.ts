import * as AccessConfig from "./AccessConfig.ts";
import {
  FOUNDRY_CAPABILITIES,
  FOUNDRY_PROTOCOL_VERSION,
  FoundryNegotiationError,
  type FoundryDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as InstanceIdentityStore from "./InstanceIdentityStore.ts";

export class InstanceDescriptor extends Context.Service<
  InstanceDescriptor,
  {
    readonly negotiate: (input: {
      readonly protocolVersion: string | undefined;
      readonly capabilities: readonly string[];
      readonly requiredCapabilities: readonly string[];
    }) => Effect.Effect<
      FoundryDescriptor,
      FoundryNegotiationError | InstanceIdentityStore.InstanceIdentityError
    >;
  }
>()("t3/foundry/InstanceDescriptor") {}

const make = Effect.gen(function* () {
  const enabled = yield* AccessConfig.AccessEnabled;
  const access = yield* Effect.serviceOption(AccessConfig.AccessConfig);
  if (enabled && Option.isNone(access))
    return yield* Effect.die(new AccessConfig.AccessConfigurationError({}));
  const capabilities = FOUNDRY_CAPABILITIES.filter(
    (capability) => enabled || capability !== "foundry.access-sessions",
  );
  const identity = yield* InstanceIdentityStore.InstanceIdentityStore;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const negotiate: InstanceDescriptor["Service"]["negotiate"] = Effect.fn(
    "InstanceDescriptor.negotiate",
  )(function* (input) {
    const supported = new Set<string>(capabilities);
    const code = !input.protocolVersion
      ? "protocol_version_required"
      : input.protocolVersion !== FOUNDRY_PROTOCOL_VERSION
        ? "protocol_version_unsupported"
        : input.requiredCapabilities.some((capability) => !supported.has(capability))
          ? "capability_unsupported"
          : undefined;
    if (code)
      return yield* new FoundryNegotiationError({
        code,
        supportedProtocolVersions: [FOUNDRY_PROTOCOL_VERSION],
        supportedCapabilities: capabilities,
      });
    const auth = yield* policy.getDescriptor();
    return {
      protocolVersion: FOUNDRY_PROTOCOL_VERSION,
      instanceId: yield* identity.getOrCreate,
      mainEnvironmentId: yield* environment.getEnvironmentId,
      capabilities,
      negotiatedCapabilities: capabilities.filter(
        (capability) =>
          input.capabilities.includes(capability) ||
          input.requiredCapabilities.includes(capability),
      ),
      ...(enabled
        ? {
            instanceAuth: {
              publicOrigin: Option.getOrThrow(access).origin,
              issuer: Option.getOrThrow(access).issuer,
              bootstrapMethods: ["cloudflare-access-jwt"] as const,
              sessionMethods: ["foundry-session-cookie"] as const,
            },
          }
        : {}),
      auth: { bootstrapMethods: auth.bootstrapMethods, sessionMethods: auth.sessionMethods },
    };
  });
  return InstanceDescriptor.of({ negotiate });
});
export const layer = Layer.effect(InstanceDescriptor, make);
