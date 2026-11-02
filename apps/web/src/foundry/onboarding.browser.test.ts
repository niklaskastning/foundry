import { expect, it, vi } from "vite-plus/test";
import { FoundryOnboarding } from "@t3tools/client-runtime/connection";
import { executeInstanceOperation } from "./onboarding";
import { readDeviceSelection, writeDeviceSelection } from "./selection";

it("keeps Main discovery when managing sign-in without a selected device, but preserves explicit disconnection", () => {
  const key = "foundry:selected-device:v1";
  const previous = sessionStorage.getItem(key);
  using _storage = {
    [Symbol.dispose]: () => {
      if (previous === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, previous);
    },
  };
  sessionStorage.removeItem(key);
  expect(readDeviceSelection()).toBeUndefined();
  writeDeviceSelection(null);
  expect(readDeviceSelection()).toBeUndefined();
  sessionStorage.setItem(key, "null");
  writeDeviceSelection(null);
  expect(readDeviceSelection()).toEqual([]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("serializes shared-cookie refresh and removal across independent callers", async () => {
  const key = "foundry:instance-binding:v1";
  const previous = localStorage.getItem(key);
  using _storage = {
    [Symbol.dispose]: () => {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
  const descriptor = {
    protocolVersion: "1",
    instanceId: "11111111-1111-4111-8111-111111111111",
    mainEnvironmentId: "22222222-2222-4222-8222-222222222222",
    capabilities: ["foundry.instance-descriptor", "foundry.access-sessions"],
    negotiatedCapabilities: ["foundry.access-sessions"],
    instanceAuth: {
      publicOrigin: window.location.origin,
      issuer: "https://team.cloudflareaccess.com",
      bootstrapMethods: ["cloudflare-access-jwt"],
      sessionMethods: ["foundry-session-cookie"],
    },
    auth: { bootstrapMethods: ["one-time-token"], sessionMethods: ["browser-session-cookie"] },
  };
  const binding = FoundryOnboarding.verifyDescriptor(descriptor, window.location.origin).binding;
  localStorage.setItem(key, JSON.stringify(binding));
  const entered = deferred();
  const release = deferred();
  const revoked: string[] = [];
  let csrf = "before-refresh";
  using _fetch = vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.startsWith("/.well-known/")) return Response.json(descriptor);
    if (path.endsWith("/refresh")) {
      entered.resolve();
      await release.promise;
      expect(new Headers(init?.headers).get("X-Foundry-CSRF")).toBe("before-refresh");
      csrf = "after-refresh";
    }
    if (path.endsWith("/logout")) {
      revoked.push(new Headers(init?.headers).get("X-Foundry-CSRF") ?? "missing");
      return new Response(null, { status: 204 });
    }
    return Response.json({
      instanceId: binding.instanceId,
      operatorId: "33333333-3333-4333-8333-333333333333",
      expiresAt: Number.MAX_SAFE_INTEGER,
      csrfToken: csrf,
    });
  });
  const refresh = executeInstanceOperation({ operation: "refresh", candidate: binding });
  await entered.promise;
  const remove = executeInstanceOperation({ operation: "remove", candidate: binding });
  await using _settle = {
    [Symbol.asyncDispose]: async () => {
      release.resolve();
      await Promise.allSettled([refresh, remove]);
    },
  };
  await vi.waitFor(async () => {
    const locks = await navigator.locks.query();
    expect(locks.pending?.some((lock) => lock.name === "foundry:instance-session:v1")).toBe(true);
  });
  expect(revoked).toEqual([]);
  release.resolve();
  expect((await refresh).session?.csrfToken).toBe("after-refresh");
  expect((await remove).binding).toBeNull();
  expect(revoked).toEqual(["after-refresh"]);
  expect(localStorage.getItem(key)).toBeNull();
});
