import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("discovers Main on the Foundry hosted origin while retaining explicit static hosting", () => {
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://foundry.example.com");
    const origin = new URL("https://foundry.example.com/settings/access");
    vi.stubGlobal("__T3CODE_FOUNDRY_BUILD__", false);
    expect(isHostedStaticApp(origin)).toBe(true);
    vi.stubGlobal("__T3CODE_FOUNDRY_BUILD__", true);
    expect(isHostedStaticApp(origin)).toBe(false);
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
    expect(isHostedStaticApp(origin)).toBe(true);
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });
});
