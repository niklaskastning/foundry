// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The native window owns its isolated Electron partition and wall-clock session expiry.
import * as NodeCrypto from "node:crypto";
import * as Electron from "electron";
import { FoundryOnboarding } from "@t3tools/client-runtime/connection";
import { isInstanceRequest } from "./AccessTransportPolicy.ts";

export async function runNativeInstance(
  selected: Omit<FoundryOnboarding.InstanceBinding, "mainEnvironmentId">,
): Promise<"close" | "switch"> {
  const key = NodeCrypto.createHash("sha256").update(JSON.stringify(selected)).digest("hex");
  const partition = Electron.session.fromPartition(`persist:foundry-native-${key}`);
  const descriptorResponse = await partition.fetch(
    `${selected.origin}/.well-known/foundry?protocolVersion=1`,
    { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) },
  );
  const descriptor = await FoundryOnboarding.readResponse(descriptorResponse);
  const verified = FoundryOnboarding.verifyDescriptor(descriptor, selected.origin, selected);
  if (!verified.descriptor.instanceAuth?.bootstrapMethods.includes("password"))
    throw new Error("This instance does not support native Foundry sign-in.");
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !isInstanceRequest(selected.origin, details.url) &&
        !details.url.startsWith(`blob:${selected.origin}/`),
    }),
  );
  const window = new Electron.BrowserWindow({
    title: "Foundry",
    width: 1280,
    height: 900,
    webPreferences: {
      partition: `persist:foundry-native-${key}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, address) => {
    if (!isInstanceRequest(selected.origin, address)) event.preventDefault();
  });
  let outcome: "close" | "switch" = "close";
  const closed = new Promise<"close" | "switch">((resolve) =>
    window.once("closed", () => resolve(outcome)),
  );
  const remove = async () => {
    try {
      const request = (operation: string, csrf?: string) =>
        partition.fetch(`${selected.origin}/api/foundry/auth/${operation}`, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            Origin: selected.origin,
            "Content-Type": "application/json",
            ...(csrf ? { "X-Foundry-CSRF": csrf } : {}),
          },
        });
      const response = await request("session");
      if (response.ok) {
        const current = FoundryOnboarding.verifySession(
          await FoundryOnboarding.readResponse(response),
          verified.binding,
          Date.now(),
        );
        await FoundryOnboarding.readResponse(await request("logout", current.csrfToken));
      } else {
        await FoundryOnboarding.readResponse(response).catch((error: unknown) => {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "invalid_session"
            )
          )
            throw error;
        });
      }
      await partition.clearStorageData();
      await partition.clearCache();
      outcome = "switch";
      window.close();
    } catch {
      await Electron.dialog.showMessageBox(window, {
        type: "error",
        message: "Could not confirm sign-out. Retry before removing this instance.",
      });
    }
  };
  window.setMenu(
    Electron.Menu.buildFromTemplate([
      {
        label: "Instance",
        submenu: [
          {
            label: "Account",
            click: () => {
              void window.loadURL(`${selected.origin}/foundry?view=instance`);
            },
          },
          {
            label: "Remove / switch instance",
            click: () => {
              void remove();
            },
          },
        ],
      },
    ]),
  );
  await window.loadURL(`${selected.origin}/foundry?view=factories`);
  return closed;
}
