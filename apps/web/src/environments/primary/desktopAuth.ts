import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}

export function readDesktopPrimaryBearerTokenForUrl(url: string): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const primary = window.desktopBridge
    ?.getLocalEnvironmentBootstraps()
    .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  if (!primary?.httpBaseUrl) return Promise.resolve(null);
  try {
    const requested = new URL(url);
    const configured = new URL(primary.httpBaseUrl);
    if (
      (requested.protocol !== "http:" && requested.protocol !== "https:") ||
      requested.username ||
      requested.password ||
      configured.username ||
      configured.password ||
      requested.origin !== configured.origin
    )
      return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return readDesktopPrimaryBearerToken();
}
