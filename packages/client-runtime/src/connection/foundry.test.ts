import { describe, expect, it } from "vite-plus/test";
import { FoundryAuthError } from "@t3tools/contracts";
import {
  createInstanceClient,
  normalizeOrigin,
  readResponse,
  verifyDescriptor,
  verifySession,
} from "./foundry.ts";

function fixture() {
  const origin = "https://main.example";
  const descriptor = {
    protocolVersion: "1",
    instanceId: "11111111-1111-4111-8111-111111111111",
    mainEnvironmentId: "22222222-2222-4222-8222-222222222222",
    capabilities: ["foundry.instance-descriptor", "foundry.access-sessions"],
    negotiatedCapabilities: ["foundry.access-sessions"],
    instanceAuth: {
      publicOrigin: origin,
      issuer: "https://team.cloudflareaccess.com",
      bootstrapMethods: ["cloudflare-access-jwt"],
      sessionMethods: ["foundry-session-cookie"],
    },
    auth: { bootstrapMethods: ["one-time-token"], sessionMethods: ["browser-session-cookie"] },
  };
  const binding = verifyDescriptor(descriptor, origin).binding;
  const session = {
    instanceId: binding.instanceId,
    operatorId: "33333333-3333-4333-8333-333333333333",
    expiresAt: 1000,
    csrfToken: "fixture-csrf",
  };
  const values = new Map<string, string>([
    ["personal-t3", "untouched"],
    ["other-instance", "untouched"],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const calls: { path: string; csrf?: string }[] = [];
  let failLogout = false;
  let invalidSession = false;
  const client = createInstanceClient({
    origin,
    storage,
    now: () => 100,
    request: async (path, csrf) => {
      calls.push({ path, ...(csrf ? { csrf } : {}) });
      if (path.startsWith("/.well-known/")) return descriptor;
      if (path.endsWith("/session") && invalidSession)
        throw new FoundryAuthError({ code: "invalid_session" });
      if (path.endsWith("/logout")) {
        if (failLogout) throw new FoundryAuthError({ code: "unavailable" });
        return undefined;
      }
      return session;
    },
  });
  return {
    origin,
    descriptor,
    binding,
    session,
    values,
    storage,
    calls,
    client,
    invalidateSession: () => {
      invalidSession = true;
    },
    failLogout: () => {
      failLogout = true;
    },
  };
}

describe("Foundry instance onboarding", () => {
  it("confirms before login, rechecks identity before mutations and preserves unrelated storage on removal", async () => {
    const f = fixture();
    await expect(f.client.execute("login")).rejects.toMatchObject({ code: "identity" });
    expect(f.calls).toHaveLength(0);
    const candidate = await f.client.execute("inspect");
    expect(candidate.confirmed).toBe(false);
    expect(f.values.size).toBe(2);
    await f.client.execute("confirm", f.binding);
    expect((await f.client.execute("login")).session).toEqual(f.session);
    expect((await f.client.execute("refresh")).session).toEqual(f.session);
    expect(f.calls.at(-1)).toEqual({ path: "/api/foundry/auth/refresh", csrf: "fixture-csrf" });
    f.descriptor.instanceAuth.issuer = "https://other.cloudflareaccess.com";
    const before = f.calls.length;
    await expect(f.client.execute("login")).rejects.toMatchObject({ code: "identity" });
    expect(f.calls.slice(before).map((call) => call.path)).toEqual([
      "/.well-known/foundry?protocolVersion=1&requiredCapability=foundry.access-sessions",
    ]);
    f.descriptor.instanceAuth.issuer = f.binding.issuer;
    expect((await f.client.execute("remove")).binding).toBeNull();
    expect(f.calls.at(-1)).toEqual({ path: "/api/foundry/auth/logout", csrf: "fixture-csrf" });
    expect([...f.values]).toEqual([
      ["personal-t3", "untouched"],
      ["other-instance", "untouched"],
    ]);
    await expect(f.client.execute("login")).rejects.toMatchObject({ code: "identity" });
    await f.client.execute("confirm", f.binding);
    f.invalidateSession();
    expect((await f.client.execute("remove")).binding).toBeNull();
    expect([...f.values]).toEqual([
      ["personal-t3", "untouched"],
      ["other-instance", "untouched"],
    ]);
  });

  it.each(["confirm", "login", "refresh", "session", "remove", "forget"] as const)(
    "rejects a stale tab's %s instead of adopting or removing another confirmed identity",
    async (operation) => {
      const f = fixture();
      await f.client.execute("confirm", f.binding);
      f.descriptor.instanceAuth.issuer = "https://replacement.cloudflareaccess.com";
      const replacement = verifyDescriptor(f.descriptor, f.origin).binding;
      f.storage.setItem("foundry:instance-binding:v1", JSON.stringify(replacement));
      const count = f.calls.length;
      await expect(f.client.execute(operation, f.binding)).rejects.toMatchObject({
        code: "identity",
      });
      expect(f.calls).toHaveLength(count);
      expect(f.client.readBinding()).toEqual(replacement);
      if (operation === "forget")
        await expect(f.client.execute("forget")).rejects.toMatchObject({ code: "identity" });
    },
  );

  it("does not restore a binding or start login after it was forgotten during descriptor verification", async () => {
    const f = fixture();
    await f.client.execute("confirm", f.binding);
    const entered = Promise.withResolvers<void>();
    const descriptor = Promise.withResolvers<unknown>();
    const paths: string[] = [];
    const client = createInstanceClient({
      origin: f.origin,
      storage: f.storage,
      now: () => 100,
      request: async (path) => {
        paths.push(path);
        if (path.startsWith("/.well-known/")) {
          entered.resolve();
          return descriptor.promise;
        }
        return f.session;
      },
    });
    const login = client.execute("login", f.binding);
    await entered.promise;
    await f.client.execute("forget", f.binding);
    descriptor.resolve(f.descriptor);
    await expect(login).rejects.toMatchObject({ code: "identity" });
    expect(paths).toEqual([
      "/.well-known/foundry?protocolVersion=1&requiredCapability=foundry.access-sessions",
    ]);
    expect(client.readBinding()).toBeUndefined();
  });

  it("retains the binding on failed revocation and refuses corrupted persisted state", async () => {
    const f = fixture();
    await f.client.execute("confirm", f.binding);
    f.failLogout();
    await expect(f.client.execute("remove")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.values.size).toBe(3);
    f.storage.setItem("foundry:instance-binding:v1", "broken");
    const count = f.calls.length;
    await expect(f.client.execute("inspect")).rejects.toMatchObject({ code: "storage" });
    expect(f.calls).toHaveLength(count);
    const forgotten = await f.client.execute("forget");
    expect(forgotten.message).toContain("NOT confirmed");
    expect(f.calls).toHaveLength(count);
    expect([...f.values]).toEqual([
      ["personal-t3", "untouched"],
      ["other-instance", "untouched"],
    ]);
  });

  it("rejects changes to each identity dimension, incompatible servers and expired or foreign sessions", () => {
    const f = fixture();
    for (const changed of [
      { ...f.descriptor, instanceId: "44444444-4444-4444-8444-444444444444" },
      { ...f.descriptor, mainEnvironmentId: "another-environment" },
      {
        ...f.descriptor,
        instanceAuth: {
          ...f.descriptor.instanceAuth,
          issuer: "https://other.cloudflareaccess.com",
        },
      },
      {
        ...f.descriptor,
        instanceAuth: { ...f.descriptor.instanceAuth, publicOrigin: "https://other.example" },
      },
    ])
      expect(() => verifyDescriptor(changed, f.origin, f.binding)).toThrow(/identity/);
    expect(() => verifyDescriptor({ ...f.descriptor, protocolVersion: "2" }, f.origin)).toThrow(
      /compatible/,
    );
    expect(() =>
      verifyDescriptor(
        {
          ...f.descriptor,
          instanceAuth: {
            bootstrapMethods: ["cloudflare-access-jwt"],
            sessionMethods: ["foundry-session-cookie"],
          },
        },
        f.origin,
      ),
    ).toThrow(/does not support/);
    expect(() => verifySession(f.session, f.binding, 1000)).toThrow(/expired/);
    expect(() =>
      verifySession(
        { ...f.session, instanceId: "44444444-4444-4444-8444-444444444444" },
        f.binding,
        100,
      ),
    ).toThrow(/identity/);
  });

  it("classifies Access pages and redirects without exposing their body or location", async () => {
    for (const response of [
      new Response("secret login HTML", { headers: { "content-type": "text/html" } }),
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/?token=secret" },
      }),
    ]) {
      await expect(readResponse(response)).rejects.toMatchObject({ code: "access" });
    }
    await expect(
      readResponse(
        Response.json({ code: "operator_mismatch", message: "untrusted text" }, { status: 403 }),
      ),
    ).rejects.toMatchObject({
      code: "operator_mismatch",
      message: "This identity is not the configured Foundry operator.",
    });
    await expect(
      readResponse(Response.json({ code: "invalid_session" }, { status: 401 })),
    ).rejects.toMatchObject({ code: "invalid_session" });
    await expect(
      readResponse(new Response("bad JSON", { headers: { "content-type": "application/json" } })),
    ).rejects.toMatchObject({ code: "descriptor" });
  });

  it("accepts only canonical HTTPS origins, with loopback HTTP explicitly enabled for development", () => {
    expect(normalizeOrigin(" https://Main.Example/ ")).toBe("https://main.example");
    for (const value of [
      "http://main.example",
      "https://user:password@main.example",
      "https://main.example/path",
      "https://main.example/?secret=1",
      "https://main.example/#token",
      "javascript:alert(1)",
      "//main.example",
      "http://127.0.0.1",
    ])
      expect(() => normalizeOrigin(value)).toThrow();
    expect(normalizeOrigin("http://127.0.0.1:1234", true)).toBe("http://127.0.0.1:1234");
    expect(() => normalizeOrigin("http://remote.example", true)).toThrow();
  });
});
