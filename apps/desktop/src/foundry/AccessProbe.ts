// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Native acceptance harness owns OS-protected state and wall-clock credential expiry.
import * as Electron from "electron";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FoundryDescriptor, FoundryInstanceId, FoundrySession } from "@t3tools/contracts";
import { AccessOAuthError, createAccessOAuth, type AccessOAuthGrant } from "./AccessOAuth.ts";

import { authorizeInstanceRequest, isInstanceRequest } from "./AccessTransportPolicy.ts";

const StoredGrant = Schema.Struct({
  origin: Schema.String,
  issuer: Schema.String,
  instanceId: FoundryInstanceId,
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
});

const decodeInstanceId = Schema.decodeSync(FoundryInstanceId);
const decodeStoredGrant = Schema.decodeUnknownSync(StoredGrant);
const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);
const decodeSession = Schema.decodeUnknownSync(FoundrySession);

export async function runAccessProbe(args: readonly string[], platform: NodeJS.Platform) {
  const [rawOrigin, rawIssuer, rawInstanceId] = args;
  if (args.length !== 3 || !rawOrigin || !rawIssuer || !rawInstanceId)
    throw new AccessOAuthError(
      "Usage: --foundry-access-probe <https-origin> <https-team-issuer> <expected-instance-id>",
    );
  const origin = rawOrigin;
  const issuer = rawIssuer;
  const instanceId = decodeInstanceId(rawInstanceId);
  const oauth = createAccessOAuth({
    origin,
    issuer,
    fetch: (url, init) => Electron.net.fetch(url instanceof URL ? url.href : url, init),
  });
  const root = NodePath.join(Electron.app.getPath("appData"), "Foundry-Auth-Probe");
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  Electron.app.setPath("userData", root);
  Electron.app.setPath("sessionData", root);
  if (!Electron.app.requestSingleInstanceLock())
    throw new AccessOAuthError("Another auth probe is already running.");
  await Electron.app.whenReady();
  // The probe's native action dialog remains usable after its remote window closes.
  Electron.app.on("window-all-closed", () => {});
  if (
    !Electron.safeStorage.isEncryptionAvailable() ||
    (platform === "linux" && Electron.safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new AccessOAuthError("OS-protected credential storage is unavailable.");
  const key = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([origin, issuer, instanceId]))
    .digest("hex");
  const file = NodePath.join(root, `${key}.bin`);
  const partition = Electron.session.fromPartition(`persist:foundry-auth-probe-${key}`);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on("will-download", (event) => event.preventDefault());
  let grant: AccessOAuthGrant | undefined;
  let expiresAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windows = new Set<Electron.BrowserWindow>();
  const controller = new AbortController();
  Electron.app.once("before-quit", () => controller.abort());
  const closeWindows = () => {
    for (const window of windows) window.destroy();
    windows.clear();
  };
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !isInstanceRequest(origin, details.url) || !grant || expiresAt <= Date.now(),
    });
  });
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(
      authorizeInstanceRequest(
        origin,
        details.url,
        details.requestHeaders,
        grant && expiresAt > Date.now() ? Redacted.value(grant.tokens.accessToken) : undefined,
      ),
    );
  });

  async function save(next: AccessOAuthGrant) {
    grant = next;
    expiresAt = Date.now() + next.tokens.expiresIn * 1000;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      closeWindows();
    }, next.tokens.expiresIn * 1000);
    await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
    const ciphertext = Electron.safeStorage.encryptString(
      JSON.stringify({
        origin,
        issuer,
        instanceId,
        clientId: next.clientId,
        accessToken: Redacted.value(next.tokens.accessToken),
        ...(next.tokens.refreshToken
          ? { refreshToken: Redacted.value(next.tokens.refreshToken) }
          : {}),
        expiresAt,
      }),
    );
    const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, ciphertext, { mode: 0o600, flag: "wx" });
      await NodeFSP.rename(temporary, file);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }

  async function restore() {
    let ciphertext: Buffer;
    try {
      ciphertext = await NodeFSP.readFile(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const value = decodeStoredGrant(JSON.parse(Electron.safeStorage.decryptString(ciphertext)));
    if (value.origin !== origin || value.issuer !== issuer || value.instanceId !== instanceId)
      throw new AccessOAuthError("Stored credentials do not match this instance.");
    const previous: AccessOAuthGrant = {
      origin,
      issuer,
      clientId: value.clientId,
      tokens: {
        accessToken: Redacted.make(value.accessToken),
        expiresIn: 0,
        ...(value.refreshToken ? { refreshToken: Redacted.make(value.refreshToken) } : {}),
      },
    };
    await save(await oauth.refresh(previous, controller.signal));
  }

  async function response(path: string, csrf?: string) {
    const result = await partition.fetch(`${origin}${path}`, {
      method: path.startsWith("/api/") ? "POST" : "GET",
      redirect: "error",
      credentials: "include",
      headers: {
        Origin: origin,
        "content-type": "application/json",
        ...(csrf ? { "X-Foundry-CSRF": csrf } : {}),
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    if (path === "/api/foundry/auth/logout" && result.status === 204) return undefined;
    if (!result.ok || !result.headers.get("content-type")?.includes("application/json")) {
      await result.body?.cancel();
      throw new AccessOAuthError(
        `Foundry request failed (HTTP ${result.status}); check Access and server configuration.`,
      );
    }
    return result.json() as Promise<unknown>;
  }

  async function verify() {
    const descriptor = decodeDescriptor(await response("/.well-known/foundry?protocolVersion=1"));
    if (descriptor.instanceId !== instanceId)
      throw new AccessOAuthError("Foundry instance identity changed.");
    if (!descriptor.capabilities.includes("foundry.access-sessions"))
      throw new AccessOAuthError(
        "Access transport reached the correct instance, but Foundry Access sessions are not enabled on Main.",
      );
    return descriptor;
  }

  async function authenticate(refresh: boolean) {
    await verify();
    let value: unknown;
    if (refresh) {
      const current = decodeSession(await response("/api/foundry/auth/session"));
      value = await response("/api/foundry/auth/refresh", current.csrfToken);
    } else value = await response("/api/foundry/auth/login");
    const session = decodeSession(value);
    if (session.instanceId !== instanceId)
      throw new AccessOAuthError("Session belongs to another instance.");
    await partition.cookies.flushStore();
  }

  async function openWindow() {
    const window = new Electron.BrowserWindow({
      title: "Foundry access probe",
      width: 1100,
      height: 800,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        devTools: false,
      },
    });
    windows.add(window);
    window.on("closed", () => windows.delete(window));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    const closed = new Promise<void>((resolve) => window.once("closed", () => resolve()));
    void window.loadURL(origin).catch(() => {
      if (!window.isDestroyed()) window.destroy();
    });
    await closed;
  }

  let status =
    "Isolated acceptance probe. No local T3 backend is started. Existing T3 pairing is still required for its WebSocket UI.";
  try {
    await restore();
    if (grant) {
      await verify();
      status = "Stored OAuth grant refreshed. Check the Foundry session or open the instance.";
    }
  } catch {
    status = "Stored sign-in could not be restored. Sign in again or log out.";
    grant = undefined;
  }
  try {
    for (;;) {
      const choice = await Electron.dialog.showMessageBox({
        type: "info",
        title: "Foundry P04 access probe",
        message: origin,
        detail: status,
        buttons: ["Sign in", "Open instance", "Refresh", "Check session", "Log out", "Close"],
        cancelId: 5,
        defaultId: 0,
      });
      if (choice.response === 5) break;
      try {
        if (choice.response === 0) {
          closeWindows();
          await save(
            await oauth.login(async (url) => {
              await Electron.shell.openExternal(url);
              return true;
            }, controller.signal),
          );
          await authenticate(false);
          status = "System-browser login and Foundry session succeeded.";
        } else if (choice.response === 1) {
          await verify();
          await openWindow();
          status = "Instance window closed. Refresh, check the session, or reopen to reconnect.";
        } else if (choice.response === 2) {
          if (!grant) throw new AccessOAuthError("Sign in first.");
          closeWindows();
          await save(await oauth.refresh(grant, controller.signal));
          await authenticate(true);
          status = "OAuth and Foundry sessions refreshed; reopen the instance to reconnect.";
        } else if (choice.response === 3) {
          await verify();
          const session = decodeSession(await response("/api/foundry/auth/session"));
          if (session.instanceId !== instanceId)
            throw new AccessOAuthError("Session belongs to another instance.");
          status = "Foundry session verified.";
        } else {
          closeWindows();
          let failed = false;
          try {
            const session = decodeSession(await response("/api/foundry/auth/session"));
            await response("/api/foundry/auth/logout", session.csrfToken);
          } catch {
            failed = true;
          }
          try {
            if (grant) await oauth.revoke(grant, controller.signal);
          } catch {
            failed = true;
          }
          grant = undefined;
          if (timer) clearTimeout(timer);
          await partition.clearStorageData();
          await partition.clearCache();
          await partition.closeAllConnections();
          await NodeFSP.rm(file, { force: true });
          status = failed
            ? "Local credentials cleared. Remote revocation could not be fully confirmed."
            : "Foundry logout and OAuth revocation succeeded; local credentials cleared.";
        }
      } catch (error) {
        status =
          error instanceof AccessOAuthError
            ? error.message
            : "Probe operation failed. No credentials are included in this report.";
      }
    }
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    closeWindows();
    await partition.cookies.flushStore();
    Electron.app.quit();
  }
}
