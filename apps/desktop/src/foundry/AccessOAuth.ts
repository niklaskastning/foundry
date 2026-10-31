// @effect-diagnostics nodeBuiltinImport:off - Native OAuth owns its loopback listener and PKCE bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384));
const Metadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String),
  grant_types_supported: Schema.Array(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: NonEmpty,
  refresh_token: Schema.optionalKey(NonEmpty),
  token_type: Schema.String,
  expires_in: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86400 })),
});

const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const decodeTokens = Schema.decodeUnknownSync(TokenResponse);
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Struct({
    client_id: NonEmpty,
    redirect_uris: Schema.Array(Schema.String),
    token_endpoint_auth_method: Schema.Literal("none"),
  }),
);

export class AccessOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessOAuthError";
  }
}

function httpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || value !== url.origin)
    throw new AccessOAuthError("An exact HTTPS origin without credentials or a path is required.");
  return url.origin;
}

function endpoint(value: string, issuer: string) {
  const url = new URL(value);
  if (url.origin !== issuer || url.username || url.password || url.hash || url.search)
    throw new AccessOAuthError("OAuth endpoint does not belong to the confirmed issuer.");
  return url.href;
}

export interface AccessOAuthTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken?: Redacted.Redacted<string>;
  readonly expiresIn: number;
}

export interface AccessOAuthGrant {
  readonly origin: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokens: AccessOAuthTokens;
}

export function createAccessOAuth(input: {
  readonly origin: string;
  readonly issuer: string;
  readonly fetch: typeof globalThis.fetch;
}) {
  const origin = httpsOrigin(input.origin);
  const issuer = httpsOrigin(input.issuer);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer))
    throw new AccessOAuthError("A confirmed Cloudflare Access team issuer is required.");

  async function request(url: string, init: RequestInit, signal: AbortSignal) {
    const response = await input.fetch(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccessOAuthError(`OAuth request failed (HTTP ${response.status}).`);
    }
    return response;
  }

  async function json(url: string, init: RequestInit, signal: AbortSignal) {
    const response = await request(url, init, signal);
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new AccessOAuthError(
        "Expected OAuth JSON; a browser challenge is not a login response.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AccessOAuthError("Empty OAuth response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) throw new AccessOAuthError("OAuth response is too large.");
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async function discover(signal: AbortSignal) {
    try {
      const metadata = decodeMetadata(
        await json(`${issuer}/.well-known/oauth-authorization-server`, {}, signal),
      );
      if (
        metadata.issuer !== issuer ||
        !metadata.code_challenge_methods_supported.includes("S256") ||
        !metadata.token_endpoint_auth_methods_supported.includes("none") ||
        !metadata.grant_types_supported.includes("authorization_code")
      )
        throw new AccessOAuthError("Issuer does not support public-client PKCE authorization.");
      return {
        authorize: endpoint(metadata.authorization_endpoint, issuer),
        token: endpoint(metadata.token_endpoint, issuer),
        register: endpoint(metadata.registration_endpoint, issuer),
        revoke: endpoint(metadata.revocation_endpoint, issuer),
      };
    } catch (error) {
      if (error instanceof AccessOAuthError) throw error;
      throw new AccessOAuthError(
        "OAuth discovery failed; verify Managed OAuth and public-client registration.",
      );
    }
  }

  async function exchange(
    url: string,
    parameters: Record<string, string>,
    signal: AbortSignal,
  ): Promise<AccessOAuthTokens> {
    try {
      const value = decodeTokens(
        await json(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ...parameters, resource: origin }),
          },
          signal,
        ),
      );
      if (value.token_type.toLowerCase() !== "bearer")
        throw new AccessOAuthError("Unsupported OAuth token type.");
      return {
        accessToken: Redacted.make(value.access_token),
        ...(value.refresh_token ? { refreshToken: Redacted.make(value.refresh_token) } : {}),
        expiresIn: value.expires_in,
      };
    } catch (error) {
      if (error instanceof AccessOAuthError) throw error;
      throw new AccessOAuthError("OAuth token exchange failed. Sign in again.");
    }
  }

  async function login(openBrowser: (url: string) => Promise<boolean>, cancellation: AbortSignal) {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(300_000)]);
    const endpoints = await discover(signal);
    let verifier: string;
    let challenge: string;
    // Access documents a parser limitation for challenges beginning with '-' or '_'.
    do {
      verifier = NodeCrypto.randomBytes(32).toString("base64url");
      challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
    } while (!/^[a-zA-Z0-9]/.test(challenge));
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const callback = Promise.withResolvers<string>();
    void callback.promise.catch(() => undefined);
    let redirect = "";
    let consumed = false;
    const server = NodeHttp.createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      response.setHeader("x-content-type-options", "nosniff");
      let url: URL;
      try {
        if (!redirect) throw new Error("Callback not ready");
        url = new URL(request.url ?? "/", redirect);
      } catch {
        response.writeHead(400).end("Invalid callback request.");
        return;
      }
      const valid =
        !consumed &&
        request.method === "GET" &&
        request.headers.host === new URL(redirect).host &&
        url.origin === new URL(redirect).origin &&
        url.pathname === "/callback" &&
        url.searchParams.getAll("state").length === 1 &&
        url.searchParams.get("state") === state;
      if (
        !valid ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("error").length > 1 ||
        (url.searchParams.has("code") && url.searchParams.has("error"))
      ) {
        response.writeHead(400).end("This response does not belong to the active sign-in.");
        return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error")) {
        consumed = true;
        response.writeHead(200).end("Sign-in was not completed. Return to Foundry.");
        callback.reject(new AccessOAuthError("OAuth sign-in was denied."));
      } else if (code && code.length <= 16384) {
        consumed = true;
        response.writeHead(200).end("Return to Foundry to finish signing in.");
        callback.resolve(code);
      } else response.writeHead(400).end("Missing authorization code.");
    });
    const abort = () =>
      callback.reject(new AccessOAuthError("OAuth sign-in cancelled or expired."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new AccessOAuthError("Could not bind callback.");
      redirect = `http://127.0.0.1:${address.port}/callback`;
      const registration = decodeRegistration(
        await json(
          endpoints.register,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              redirect_uris: [redirect],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              resource: origin,
            }),
          },
          signal,
        ),
      );
      if (registration.redirect_uris.length !== 1 || registration.redirect_uris[0] !== redirect)
        throw new AccessOAuthError("Registration changed the callback URI.");
      const authorization = new URL(endpoints.authorize);
      authorization.search = new URLSearchParams({
        client_id: registration.client_id,
        redirect_uri: redirect,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        resource: origin,
      }).toString();
      signal.throwIfAborted();
      if (!(await openBrowser(authorization.href)))
        throw new AccessOAuthError("Could not open the system browser.");
      const code = await callback.promise;
      const tokens = await exchange(
        endpoints.token,
        {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          client_id: registration.client_id,
        },
        signal,
      );
      return { origin, issuer, tokens, clientId: registration.client_id };
    } catch (error) {
      if (error instanceof AccessOAuthError) throw error;
      throw new AccessOAuthError("OAuth sign-in failed; no credentials were saved.");
    } finally {
      signal.removeEventListener("abort", abort);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function assertGrant(grant: AccessOAuthGrant) {
    if (grant.origin !== origin || grant.issuer !== issuer)
      throw new AccessOAuthError("OAuth credentials belong to another instance origin or issuer.");
  }

  async function refresh(grant: AccessOAuthGrant, signal: AbortSignal): Promise<AccessOAuthGrant> {
    assertGrant(grant);
    if (!grant.tokens.refreshToken)
      throw new AccessOAuthError("Sign in again; no refresh token is available.");
    const endpoints = await discover(signal);
    const tokens = await exchange(
      endpoints.token,
      {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(grant.tokens.refreshToken),
        client_id: grant.clientId,
      },
      signal,
    );
    return {
      ...grant,
      tokens: { ...tokens, refreshToken: tokens.refreshToken ?? grant.tokens.refreshToken },
    };
  }

  async function revoke(grant: AccessOAuthGrant, signal: AbortSignal) {
    assertGrant(grant);
    const endpoints = await discover(signal);
    const response = await request(
      endpoints.revoke,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: grant.clientId,
          token: Redacted.value(grant.tokens.refreshToken ?? grant.tokens.accessToken),
          token_type_hint: grant.tokens.refreshToken ? "refresh_token" : "access_token",
        }),
      },
      signal,
    );
    await response.body?.cancel();
  }

  return { discover, login, refresh, revoke };
}
