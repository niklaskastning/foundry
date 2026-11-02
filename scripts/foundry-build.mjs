import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { foundryBuildMetadata } from "./lib/foundry-build-metadata.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Build bootstrap selects the Vite+ executable before launching any application runtime.
const platform = process.platform;

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const profile = JSON.parse(
  NodeFS.readFileSync(new URL("../deploy/fork/profile.json", import.meta.url), "utf8"),
);
const target = process.argv[2];
if (!["server", "windows"].includes(target))
  throw new Error("Usage: vp run foundry:build <server|windows>");
if (target === "windows" && platform !== "win32")
  throw new Error(
    "Build the Windows installer on Windows or use the manual Foundry build workflow.",
  );
const relay = process.env.T3CODE_RELAY_URL?.trim();
if (relay) {
  const url = new URL(relay);
  if (
    url.protocol !== "https:" ||
    url.hostname === "t3.codes" ||
    url.hostname.endsWith(".t3.codes")
  )
    throw new Error("Foundry requires its own HTTPS Connect origin.");
  if (!process.env.T3CODE_CLERK_PUBLISHABLE_KEY || !process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID)
    throw new Error("Own Connect requires its own Clerk public configuration.");
}
const env = {
  ...process.env,
  T3CODE_FOUNDRY_BUILD: "1",
  T3CODE_HOSTED_APP_URL: profile.hostedAppUrl,
  VITE_HOSTED_APP_URL: profile.hostedAppUrl,
  T3CODE_TELEMETRY_CHANNEL: "dev",
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "1",
  T3CODE_DESKTOP_UPDATE_REPOSITORY: profile.repository,
};
for (const name of Object.keys(env)) {
  if (name.includes("OTLP") || name === "VITE_WS_URL" || name === "VITE_HTTP_URL") delete env[name];
}
const args =
  target === "server" ? ["run", "--filter", "t3", "build"] : ["run", "dist:desktop:win:x64"];
const metadata =
  target === "server"
    ? foundryBuildMetadata(root, process.env.FOUNDRY_ARCHIVE_REVISION)
    : undefined;
if (target === "server")
  NodeFS.rmSync(new URL("../apps/server/dist/foundry-build.json", import.meta.url), {
    force: true,
  });
const result = NodeChildProcess.spawnSync(platform === "win32" ? "vp.cmd" : "vp", args, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: platform === "win32",
});
if (result.error) throw result.error;
if (result.status === 0 && target === "server") {
  NodeFS.writeFileSync(
    new URL("../apps/server/dist/foundry-build.json", import.meta.url),
    JSON.stringify({ repository: profile.repository, ...metadata }) + "\n",
  );
}
process.exit(result.status ?? 1);
