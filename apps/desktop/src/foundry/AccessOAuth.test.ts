// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Native callback tests use real isolated loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { createAccessOAuth } from "./AccessOAuth.ts";

const origin = "https://foundry.example";
const issuer = "https://team.cloudflareaccess.com";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  revocation_endpoint: `${issuer}/revoke`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  grant_types_supported: ["authorization_code", "refresh_token"],
};

function fixture(overrides: Record<string, unknown> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  let redirect = "";
  const oauth = createAccessOAuth({
    origin,
    issuer,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      if (String(url).endsWith("oauth-authorization-server"))
        return Response.json({ ...metadata, ...overrides });
      if (url === metadata.registration_endpoint) {
        const data = JSON.parse(String(init.body));
        redirect = data.redirect_uris[0];
        expect(data.resource).toBe(origin);
        return Response.json({
          client_id: "client",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        });
      }
      if (url === metadata.token_endpoint)
        return Response.json({
          access_token: "private-access",
          refresh_token: "private-refresh",
          token_type: "bearer",
          expires_in: 900,
        });
      if (url === metadata.revocation_endpoint) return new Response(null, { status: 200 });
      throw new Error("Unexpected endpoint");
    },
  });
  return { oauth, requests, redirect: () => redirect };
}

describe("Foundry Access OAuth", () => {
  it("binds the PKCE exchange and refresh/revocation to the confirmed resource without exposing credentials", async () => {
    const { oauth, requests } = fixture();
    let challenge = "";
    const grant = await oauth.login(async (address) => {
      const authorization = new URL(address);
      expect(authorization.origin).toBe(issuer);
      expect(authorization.searchParams.get("resource")).toBe(origin);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      challenge = authorization.searchParams.get("code_challenge")!;
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      callback.search = new URLSearchParams({ state: "foreign", code: "private-code" }).toString();
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.append("code", "duplicate");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("code", "private-code");
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("private-code");
      expect((await fetch(callback)).status).toBe(400);
      return true;
    }, new AbortController().signal);
    const exchange = requests.find((request) => request.url === metadata.token_endpoint)!;
    const body = new URLSearchParams(String(exchange.init.body));
    expect(
      NodeCrypto.createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
    ).toBe(challenge);
    expect(body.get("code")).toBe("private-code");
    expect(body.get("resource")).toBe(origin);
    expect(JSON.stringify(grant)).not.toContain("private-access");
    expect(JSON.stringify(grant)).not.toContain("private-refresh");
    expect(Redacted.value(grant.tokens.accessToken)).toBe("private-access");
    await oauth.refresh(grant, new AbortController().signal);
    await oauth.revoke(grant, new AbortController().signal);
    const count = requests.length;
    await expect(
      oauth.refresh({ ...grant, origin: "https://another.example" }, new AbortController().signal),
    ).rejects.toThrow("another instance");
    await expect(
      oauth.revoke(
        { ...grant, issuer: "https://other.cloudflareaccess.com" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("another instance");
    expect(requests).toHaveLength(count);
  });

  it("rejects untrusted endpoints, incomplete discovery and insecure origins before registration", async () => {
    for (const overrides of [
      { issuer: "https://other.cloudflareaccess.com" },
      { registration_endpoint: "https://attacker.example/register" },
      { token_endpoint: `${issuer}/token?forward=evil` },
      { revocation_endpoint: `https://user:password@team.cloudflareaccess.com/revoke` },
      { code_challenge_methods_supported: ["plain"] },
      { registration_endpoint: undefined },
    ]) {
      const { oauth, requests } = fixture(overrides);
      await expect(oauth.discover(new AbortController().signal)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }
    expect(() => createAccessOAuth({ origin: "http://foundry.example", issuer, fetch })).toThrow(
      "HTTPS",
    );
    expect(() => createAccessOAuth({ origin, issuer: "https://other.example", fetch })).toThrow(
      "team issuer",
    );
  });

  it("cancels, handles denial and closes the callback socket without exchanging a code", async () => {
    for (const action of ["cancel", "deny", "browser-failure"]) {
      const { oauth, requests, redirect } = fixture();
      const controller = new AbortController();
      await expect(
        oauth.login(async (address) => {
          if (action === "cancel") controller.abort();
          else if (action === "deny") {
            const authorization = new URL(address);
            const callback = new URL(redirect());
            callback.search = new URLSearchParams({
              state: authorization.searchParams.get("state")!,
              error: "access_denied",
            }).toString();
            await fetch(callback);
          }
          return action !== "browser-failure";
        }, controller.signal),
      ).rejects.toThrow();
      expect(requests.some((request) => request.url === metadata.token_endpoint)).toBe(false);
      await expect(fetch(redirect())).rejects.toThrow();
    }
  });
});
