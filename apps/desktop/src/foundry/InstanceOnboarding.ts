// @effect-diagnostics nodeBuiltinImport:off - The native entry point owns its isolated Electron profile.
import * as Electron from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { FoundryInstanceId } from "@t3tools/contracts";
import { FoundryOnboarding } from "@t3tools/client-runtime/connection";
import { runAccessProbe } from "./AccessProbe.ts";

const Selection = Schema.Struct({
  origin: Schema.String,
  issuer: Schema.String,
  instanceId: FoundryInstanceId,
});
type Selection = typeof Selection.Type;
const decodeSelection = Schema.decodeUnknownSync(Selection);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

async function choose(previous?: Selection): Promise<Selection | undefined> {
  const window = new Electron.BrowserWindow({
    title: "Foundry: choose instance",
    width: 640,
    height: 560,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: "foundry-instance-picker",
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  const result = new Promise<Selection | undefined>((resolve) => {
    window.once("closed", () => resolve(undefined));
    window.webContents.on("will-navigate", (event, address) => {
      event.preventDefault();
      const url = new URL(address);
      if (url.origin !== "https://foundry-selection.invalid" || url.pathname !== "/") return;
      try {
        const origin = FoundryOnboarding.normalizeOrigin(url.searchParams.get("origin") ?? "");
        const issuer = FoundryOnboarding.normalizeOrigin(url.searchParams.get("issuer") ?? "");
        if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer))
          throw new Error("issuer");
        const selected = decodeSelection({
          origin,
          issuer,
          instanceId: url.searchParams.get("instanceId"),
        });
        resolve(selected);
        window.destroy();
      } catch {
        void Electron.dialog.showMessageBox(window, {
          type: "error",
          message:
            "Enter an HTTPS instance origin, Cloudflare team issuer and valid instance UUID confirmed by your operator.",
        });
      }
    });
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://foundry-selection.invalid"><title>Foundry instance</title><style>body{font:16px system-ui;background:#151719;color:#ededed;padding:28px}label{display:block;margin:16px 0 5px}input{box-sizing:border-box;width:100%;padding:10px;background:#25282b;color:inherit;border:1px solid #62676b;border-radius:6px}button{margin-top:24px;padding:10px 20px}p{color:#b9bfc4;line-height:1.5}</style></head><body><h1>Choose your Foundry instance</h1><p>Confirm these public values with your operator. System-browser Access sign-in follows. This isolated client starts no local backend.</p><form action="https://foundry-selection.invalid/" method="get"><label for="origin">Instance URL</label><input id="origin" name="origin" required value="${escape(previous?.origin ?? "")}" placeholder="https://foundry.example.com"><label for="issuer">Access issuer</label><input id="issuer" name="issuer" required value="${escape(previous?.issuer ?? "")}" placeholder="https://team.cloudflareaccess.com"><label for="instanceId">Confirmed instance ID</label><input id="instanceId" name="instanceId" required value="${escape(previous?.instanceId ?? "")}"><button type="submit">Confirm and continue</button></form><p>Device discovery and gateway access are not available yet.</p></body></html>`)}`,
  );
  return result;
}

export async function runInstanceOnboarding(platform: NodeJS.Platform) {
  const root = NodePath.join(Electron.app.getPath("appData"), "Foundry-Instances");
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  Electron.app.setPath("userData", root);
  Electron.app.setPath("sessionData", root);
  if (!Electron.app.requestSingleInstanceLock())
    throw new Error("Foundry instance client is already running.");
  await Electron.app.whenReady();
  Electron.app.on("window-all-closed", () => {});
  const file = NodePath.join(root, "selection.json");
  let previous: Selection | undefined;
  try {
    previous = decodeSelection(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new FoundryOnboarding.OnboardingError("storage");
  }
  for (;;) {
    const selected = await choose(previous);
    if (!selected) break;
    if (previous && JSON.stringify(previous) !== JSON.stringify(selected)) {
      await Electron.dialog.showMessageBox({
        type: "warning",
        message:
          "Open the saved instance and use Remove / switch instance before choosing another identity.",
      });
      continue;
    }
    await NodeFSP.writeFile(file, JSON.stringify(selected), { mode: 0o600 });
    const outcome = await runAccessProbe(
      [selected.origin, selected.issuer, selected.instanceId],
      platform,
      root,
    );
    if (outcome === "close") break;
    await NodeFSP.rm(file, { force: true });
    previous = undefined;
  }
  Electron.app.quit();
}
