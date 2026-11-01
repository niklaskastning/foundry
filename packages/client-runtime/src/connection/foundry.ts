import {
  FoundryAuthError,
  FoundryDescriptor,
  FoundryInstanceId,
  FoundrySession,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const InstanceBinding = Schema.Struct({
  origin: Schema.String,
  issuer: Schema.String,
  instanceId: FoundryInstanceId,
  mainEnvironmentId: EnvironmentId,
});
export type InstanceBinding = typeof InstanceBinding.Type;

const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);
const decodeAuthError = Schema.decodeUnknownSync(FoundryAuthError);
const isAuthError = Schema.is(FoundryAuthError);
const decodeSession = Schema.decodeUnknownSync(FoundrySession);
const decodeBinding = Schema.decodeUnknownSync(InstanceBinding);

export class OnboardingError extends Error {
  readonly code:
    | "address"
    | "access"
    | "network"
    | "descriptor"
    | "identity"
    | "unsupported"
    | "session"
    | "storage";

  constructor(code: OnboardingError["code"]) {
    super(
      {
        address: "Enter an HTTPS instance origin without credentials, a path, query or fragment.",
        access:
          "The instance returned a login page or redirect. Complete Access sign-in at the instance origin, then retry. Redirect targets are not followed by this client.",
        network:
          "The instance could not be reached. Check the address, network and Access sign-in, then retry.",
        descriptor: "This server did not return a compatible Foundry descriptor.",
        identity:
          "The instance identity, origin or issuer changed. Access is blocked; verify the deployment with its operator before removing the saved binding.",
        unsupported:
          "This server does not support Foundry instance onboarding. Access sessions and public origin/issuer metadata are required; native sign-in is not available yet.",
        session: "The Foundry session is missing, expired or revoked. Sign in again.",
        storage:
          "The saved instance could not be read or updated. No existing binding was replaced.",
      }[code],
    );
    this.code = code;
  }
}

export function normalizeOrigin(raw: string, allowLoopback = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OnboardingError("address");
  }
  if (
    (url.protocol !== "https:" &&
      !(
        allowLoopback &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new OnboardingError("address");
  return url.origin;
}

export function verifyDescriptor(
  value: unknown,
  origin: string,
  expected?: Pick<InstanceBinding, "instanceId" | "issuer"> & Partial<InstanceBinding>,
): { binding: InstanceBinding; descriptor: FoundryDescriptor } {
  let descriptor: FoundryDescriptor;
  try {
    descriptor = decodeDescriptor(value);
  } catch {
    throw new OnboardingError("descriptor");
  }
  const auth = descriptor.instanceAuth;
  if (
    !descriptor.capabilities.includes("foundry.access-sessions") ||
    !auth?.publicOrigin ||
    !auth.issuer ||
    !auth.bootstrapMethods.includes("cloudflare-access-jwt") ||
    !auth.sessionMethods.includes("foundry-session-cookie")
  )
    throw new OnboardingError("unsupported");
  if (auth.publicOrigin !== origin || normalizeOrigin(auth.issuer) !== auth.issuer)
    throw new OnboardingError("identity");
  const binding = {
    origin,
    issuer: auth.issuer,
    instanceId: descriptor.instanceId,
    mainEnvironmentId: descriptor.mainEnvironmentId,
  };
  if (
    expected &&
    (expected.instanceId !== binding.instanceId ||
      expected.issuer !== binding.issuer ||
      (expected.origin !== undefined && expected.origin !== origin) ||
      (expected.mainEnvironmentId !== undefined &&
        expected.mainEnvironmentId !== binding.mainEnvironmentId))
  )
    throw new OnboardingError("identity");
  return { binding, descriptor };
}

export async function readResponse(response: Response): Promise<unknown> {
  if (
    response.type === "opaqueredirect" ||
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    response.headers.get("content-type")?.includes("text/html")
  ) {
    await response.body?.cancel();
    throw new OnboardingError("access");
  }
  if (response.status === 204) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new OnboardingError("descriptor");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new OnboardingError("descriptor");
  }
  if (!response.ok) {
    try {
      throw decodeAuthError({
        ...(typeof value === "object" && value !== null ? value : {}),
        _tag: "FoundryAuthError",
      });
    } catch (error) {
      if (isAuthError(error)) throw error;
      throw new OnboardingError(response.status === 401 ? "session" : "unsupported");
    }
  }
  return value;
}

export function verifySession(
  value: unknown,
  binding: InstanceBinding,
  now: number,
): FoundrySession {
  let session: FoundrySession;
  try {
    session = decodeSession(value);
  } catch {
    throw new OnboardingError("session");
  }
  if (session.instanceId !== binding.instanceId) throw new OnboardingError("identity");
  if (session.expiresAt <= now) throw new OnboardingError("session");
  return session;
}

export function errorMessage(error: unknown): string {
  return error instanceof OnboardingError || isAuthError(error)
    ? error.message
    : new OnboardingError("network").message;
}

export type Operation =
  | "inspect"
  | "confirm"
  | "login"
  | "refresh"
  | "session"
  | "remove"
  | "forget";
export interface OnboardingResult {
  binding: InstanceBinding | null;
  confirmed: boolean;
  session: FoundrySession | null;
  message: string;
}

const STORAGE_KEY = "foundry:instance-binding:v1";

export function createInstanceClient(options: {
  readonly origin: string;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly now: () => number;
  readonly request: (path: string, csrf?: string) => Promise<unknown>;
}) {
  function readBinding() {
    try {
      const raw = options.storage.getItem(STORAGE_KEY);
      return raw === null ? undefined : decodeBinding(JSON.parse(raw));
    } catch {
      throw new OnboardingError("storage");
    }
  }

  async function execute(
    operation: Operation,
    candidate?: InstanceBinding,
  ): Promise<OnboardingResult> {
    if (operation === "forget") {
      try {
        options.storage.removeItem(STORAGE_KEY);
      } catch {
        throw new OnboardingError("storage");
      }
      return {
        binding: null,
        confirmed: false,
        session: null,
        message:
          "Local identity forgotten. Remote Foundry session revocation is NOT confirmed. Use the original instance or operator recovery to revoke it; Access SSO and independent T3 sessions remain separate.",
      };
    }
    const saved = readBinding();
    const request = options.request;
    if (operation !== "inspect" && !saved && operation !== "confirm")
      throw new OnboardingError("identity");
    const { binding } = verifyDescriptor(
      await request(
        "/.well-known/foundry?protocolVersion=1&requiredCapability=foundry.access-sessions",
      ),
      options.origin,
      saved ?? candidate,
    );
    if (operation === "confirm") {
      if (!candidate) throw new OnboardingError("identity");
      try {
        options.storage.setItem(STORAGE_KEY, JSON.stringify(binding));
      } catch {
        throw new OnboardingError("storage");
      }
    }
    if (operation === "inspect" || operation === "confirm")
      return {
        binding,
        confirmed: Boolean(saved) || operation === "confirm",
        session: null,
        message: "Descriptor verified. Confirm the instance before signing in.",
      };
    if (operation === "remove") {
      try {
        const session = verifySession(
          await request("/api/foundry/auth/session"),
          binding,
          options.now(),
        );
        await request("/api/foundry/auth/logout", session.csrfToken);
      } catch (error) {
        if (!(isAuthError(error) && error.code === "invalid_session")) throw error;
      }
      try {
        options.storage.removeItem(STORAGE_KEY);
      } catch {
        throw new OnboardingError("storage");
      }
      return {
        binding: null,
        confirmed: false,
        session: null,
        message:
          "No valid Foundry session remains and the saved binding was removed. Independent T3 pairing and Access browser SSO are managed separately.",
      };
    }
    const current =
      operation === "refresh"
        ? verifySession(await request("/api/foundry/auth/session"), binding, options.now())
        : null;
    const session = verifySession(
      await request(`/api/foundry/auth/${operation}`, current?.csrfToken),
      binding,
      options.now(),
    );
    return {
      binding,
      confirmed: true,
      session,
      message:
        "Signed in to Foundry. This session does not grant T3 environment or gateway access.",
    };
  }

  return { execute, readBinding };
}
