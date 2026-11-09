import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { connectionAtomRuntime } from "./runtime";
import { isStandaloneFoundryPage } from "../foundry/pageMode";

function visit(path: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

describe("connectionAtomRuntime", () => {
  it.each(["/guest?share=share-1", "/foundry"])(
    "connects to no environment on %s",
    async (path) => {
      using _page = visit(path);
      using socket = vi.spyOn(window, "WebSocket");
      const registry = AtomRegistry.make();
      using _mounted = { [Symbol.dispose]: registry.mount(connectionAtomRuntime) };
      await vi.waitFor(() => {
        const result = registry.get(connectionAtomRuntime);
        expect(AsyncResult.isFailure(result) && String(Cause.squash(result.cause))).toContain(
          "This standalone page has no environment connection.",
        );
      });
      expect(socket).not.toHaveBeenCalled();
    },
  );
});

it.each(["factories", "runs", "inbox"])(
  "verifies the saved identity before connecting the Foundry %s view",
  async (view) => {
    using _page = visit(`/foundry?view=${view}`);
    const key = "foundry:instance-binding:v1";
    const previous = localStorage.getItem(key);
    using _storage = {
      [Symbol.dispose]: () => {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      },
    };
    localStorage.removeItem(key);
    expect(isStandaloneFoundryPage("/foundry", `?view=${view}`)).toBe(true);
    localStorage.setItem(
      key,
      JSON.stringify({
        origin: window.location.origin,
        issuer: "https://team.cloudflareaccess.com",
        instanceId: "11111111-1111-4111-8111-111111111111",
        mainEnvironmentId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(isStandaloneFoundryPage("/foundry", "")).toBe(true);
    expect(isStandaloneFoundryPage("/foundry", "?view=unknown")).toBe(true);
    expect(isStandaloneFoundryPage("/foundry", `?view=${view}`)).toBe(true);
    using fetch = vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
    using socket = vi.spyOn(window, "WebSocket");
    const registry = AtomRegistry.make();
    using _mounted = { [Symbol.dispose]: registry.mount(connectionAtomRuntime) };
    await vi.waitFor(() => {
      const result = registry.get(connectionAtomRuntime);
      expect(AsyncResult.isFailure(result) && String(Cause.squash(result.cause))).toContain(
        "Saved Foundry identity could not be verified.",
      );
    });
    expect(fetch).toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  },
);
