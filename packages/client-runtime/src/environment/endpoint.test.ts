import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, normalizeHttpBaseUrl, environmentEndpointUrl } from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(
      environmentEndpointUrl("https://main.test/api/foundry/gateway/devices/device/", "/api/files"),
    ).toBe("https://main.test/api/foundry/gateway/devices/device/api/files");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});
