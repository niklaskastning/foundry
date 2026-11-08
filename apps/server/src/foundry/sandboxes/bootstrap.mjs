import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const WORKSPACE = "/workspace";
const PRIVATE = "/workspace/.foundry";
const RUNTIME = "/run/foundry";
const SERVER = "/app/dist/bin.mjs";
const LIMIT = 64 * 1024;
const PACKAGE_INSTALL_ENVIRONMENT = {
  npm_config_package_import_method: "copy",
  pnpm_config_package_import_method: "copy",
};

const writeJson = async (path, value) => {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await NodeFSP.rename(temporary, path);
};
const readJson = async (path) => JSON.parse(await NodeFSP.readFile(path, "utf8"));
const stdinJson = async () => {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new Error("input_limit");
  }
  return JSON.parse(buffer);
};
const exists = async (path) =>
  NodeFSP.stat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
const execute = (argv, cwd, output) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(argv[0], argv.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: `${WORKSPACE}/home`,
        LANG: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
        ...PACKAGE_INSTALL_ENVIRONMENT,
        ...(process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256 &&
        NodeFS.existsSync(`${PRIVATE}/control-ca.pem`)
          ? { NODE_EXTRA_CA_CERTS: `${PRIVATE}/control-ca.pem` }
          : {}),
        FOUNDRY_SANDBOX_ALLOCATION_ID: process.env.FOUNDRY_SANDBOX_ALLOCATION_ID,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = "";
    const collect = (chunk) => {
      const text = chunk.toString();
      bytes = (bytes + text).slice(-LIMIT);
      if (output) output(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => reject(new Error("command_unavailable")));
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error("command_failed"));
      else resolve(bytes.trim());
    });
  });

export const versionMatches = (output, version) => {
  if (typeof version !== "string" || !version.length || version.length > 128) return false;
  return output.split(/\s+/).some((token) => token === version || token === `v${version}`);
};
export const validateDeadline = (expiresAt, maximum, now) => {
  if (
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(maximum) ||
    expiresAt <= now ||
    expiresAt > maximum ||
    maximum - now > 7 * 86400000
  )
    throw new Error("invalid_deadline");
  return expiresAt;
};

export const setup = async (
  input,
  paths = { workspace: WORKSPACE, private: PRIVATE },
  run = execute,
) => {
  if (
    !input ||
    !/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(input.repositoryUrl) ||
    !/^[a-f0-9]{40}$/.test(input.revision) ||
    !Array.isArray(input.setup) ||
    input.setup.length > 32 ||
    !Array.isArray(input.tools) ||
    input.tools.length > 32
  )
    throw new Error("invalid_setup");
  for (const argv of input.setup)
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      argv.length > 64 ||
      argv.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))
    )
      throw new Error("invalid_setup");
  for (const tool of input.tools)
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(tool.command) ||
      typeof tool.version !== "string" ||
      !tool.version.length ||
      tool.version.length > 128
    )
      throw new Error("invalid_tools");
  const resumedPath = NodePath.join(paths.private, "resumed.json");
  const resumed = (await exists(resumedPath)) ? await readJson(resumedPath) : null;
  if ((await exists(NodePath.join(paths.private, "resume-receipt.json"))) && !resumed)
    throw new Error("resume_required");
  if (resumed) {
    const receipt = await readJson(NodePath.join(paths.private, "resume-receipt.json"));
    if (resumed.digest !== receipt.digest) throw new Error("resume_drift");
    if (receipt.manifest.remoteBase && receipt.manifest.remoteBase.url !== input.repositoryUrl)
      throw new Error("resume_repository_mismatch");
    if (!(await NodeFSP.lstat(NodePath.join(paths.workspace, "repo"))).isDirectory())
      throw new Error("resume_workspace_missing");
  }
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(resumed ? { input, resumeDigest: resumed.digest } : input))
    .digest("hex");
  const statePath = NodePath.join(paths.private, "setup.json");
  await NodeFSP.mkdir(paths.private, { recursive: true, mode: 0o700 });
  if (await exists(statePath)) {
    const previous = await readJson(statePath);
    if (previous.fingerprint !== fingerprint) throw new Error("setup_drift");
    if (previous.state === "ready") return previous;
  }
  const repo = NodePath.join(paths.workspace, "repo");
  let stage = "checkout";
  let logs = "";
  const capture = (value) => {
    logs = (logs + value).slice(-LIMIT);
    NodeFS.writeFileSync(NodePath.join(paths.private, "setup.log"), logs, { mode: 0o600 });
  };
  await writeJson(statePath, { state: "setup", fingerprint, stage });
  try {
    if (!resumed) {
      await NodeFSP.mkdir(repo, { recursive: true });
      await run(["git", "init", "--quiet", repo], paths.workspace, capture);
      await run(
        ["git", "-C", repo, "config", "remote.origin.url", input.repositoryUrl],
        paths.workspace,
        capture,
      );
      await run(
        [
          "git",
          "-C",
          repo,
          "-c",
          "protocol.file.allow=never",
          "-c",
          "credential.helper=",
          "fetch",
          "--no-tags",
          "--",
          input.repositoryUrl,
          input.revision,
        ],
        paths.workspace,
        capture,
      );
      const fetched = await run(
        ["git", "-C", repo, "rev-parse", "FETCH_HEAD"],
        paths.workspace,
        capture,
      );
      if (fetched !== input.revision) throw new Error("checkout_mismatch");
      await run(
        ["git", "-C", repo, "checkout", "--detach", input.revision],
        paths.workspace,
        capture,
      );
    } else if (!(await NodeFSP.lstat(repo)).isDirectory())
      throw new Error("resume_workspace_missing");
    stage = "setup";
    for (const argv of input.setup) {
      await writeJson(statePath, { state: "setup", fingerprint, stage });
      await run(argv, repo, capture);
      await NodeFSP.writeFile(NodePath.join(paths.private, "setup.log"), logs, { mode: 0o600 });
    }
    stage = "tools";
    const tools = [];
    for (const tool of input.tools) {
      const output = await run([tool.command, "--version"], repo, capture);
      if (!versionMatches(output, tool.version)) throw new Error("tool_version_mismatch");
      tools.push({ command: tool.command, version: tool.version });
    }
    stage = "skills";
    if (input.skills?.length) {
      const skillFile = NodePath.join(paths.private, "profile-skills.json");
      await writeJson(skillFile, input.skills);
      await run(
        ["node", SERVER, "foundry", "sandbox-skills", "--input", skillFile, "--cwd", repo],
        repo,
        capture,
      );
    }
    const state = { state: "ready", fingerprint, revision: input.revision, tools };
    await writeJson(statePath, state);
    await NodeFSP.writeFile(NodePath.join(paths.private, "setup.log"), logs, { mode: 0o600 });
    return state;
  } catch {
    await writeJson(statePath, { state: "failed", fingerprint, stage });
    await NodeFSP.writeFile(NodePath.join(paths.private, "setup.log"), logs, { mode: 0o600 });
    throw new Error(stage);
  }
};

const requireSetup = async () => {
  const state = await readJson(`${PRIVATE}/setup.json`);
  if (state.state !== "ready") throw new Error("setup_required");
};
const ensureIdentity = async () => {
  await requireSetup();
  const home = `${PRIVATE}/t3/userdata`;
  await NodeFSP.mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await exists(`${home}/environment-id`)))
    await NodeFSP.writeFile(`${home}/environment-id`, NodeCrypto.randomUUID() + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  if (!(await exists(`${PRIVATE}/device-key.json`)))
    await execute(
      [
        process.execPath,
        SERVER,
        "foundry",
        "device-keygen",
        "--output",
        `${PRIVATE}/device-key.json`,
      ],
      WORKSPACE,
    );
  const key = await readJson(`${PRIVATE}/device-key.json`);
  return {
    environmentId: (await NodeFSP.readFile(`${home}/environment-id`, "utf8")).trim(),
    publicKey: key.publicKey,
  };
};
const signEnrollment = async (input) => {
  await ensureIdentity();
  const invitation = `${RUNTIME}/invitation.json`;
  const request = `${RUNTIME}/enrollment.json`;
  await writeJson(invitation, input);
  await NodeFSP.rm(request, { force: true });
  try {
    await execute(
      [
        process.execPath,
        SERVER,
        "foundry",
        "sign-enrollment",
        "--invitation",
        invitation,
        "--key-file",
        `${PRIVATE}/device-key.json`,
        "--output",
        request,
      ],
      WORKSPACE,
    );
    return await readJson(request);
  } finally {
    await NodeFSP.rm(invitation, { force: true });
    await NodeFSP.rm(request, { force: true });
  }
};

export const prepareRuntime = async (
  input,
  identity,
  privateDirectory = PRIVATE,
  workspaceDirectory = WORKSPACE,
) => {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.origin ||
    origin.username ||
    origin.password ||
    !input.registration ||
    input.registration.environmentId !== identity.environmentId ||
    input.registration.publicKey !== identity.publicKey
  )
    throw new Error("runtime_identity");
  if (
    input.environment &&
    Object.entries(input.environment).some(
      ([key, value]) =>
        ![
          "FOUNDRY_SANDBOX_ALLOCATION_ID",
          "T3CODE_TELEMETRY_ENABLED",
          "T3CODE_DISABLE_AUTO_UPDATE",
        ].includes(key) || typeof value !== "string",
    )
  )
    throw new Error("runtime_environment");
  if (input.controlCaPem !== undefined) {
    if (
      typeof input.controlCaPem !== "string" ||
      input.controlCaPem.length > 16384 ||
      !/^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(
        input.controlCaPem,
      )
    )
      throw new Error("runtime_control_ca");
    const ca = new NodeCrypto.X509Certificate(input.controlCaPem);
    const expected = process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256;
    if (
      !ca.ca ||
      !expected ||
      NodeCrypto.createHash("sha256").update(ca.raw).digest("hex") !== expected
    )
      throw new Error("runtime_control_ca");
    const caFile = `${privateDirectory}/control-ca.pem`;
    if ((await exists(caFile)) && (await NodeFSP.readFile(caFile, "utf8")) !== input.controlCaPem)
      throw new Error("runtime_control_ca_drift");
    await NodeFSP.writeFile(caFile, input.controlCaPem, { mode: 0o600 });
  } else if (process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256)
    throw new Error("runtime_control_ca_required");
  const environment = {
    ...input.environment,
    ...PACKAGE_INSTALL_ENVIRONMENT,
    ...(input.controlCaPem ? { NODE_EXTRA_CA_CERTS: `${privateDirectory}/control-ca.pem` } : {}),
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  };
  const binding = {
    origin: input.origin,
    registrationFile: `${privateDirectory}/registration.json`,
    keyFile: `${privateDirectory}/device-key.json`,
  };
  await writeJson(binding.registrationFile, input.registration);
  await writeJson(`${privateDirectory}/artifact-binding.json`, binding);
  environment.FOUNDRY_WORKER_ARTIFACT_BINDING_FILE = `${privateDirectory}/artifact-binding.json`;
  if (input.providerBinding) {
    const provider = input.providerBinding;
    const keys = [
      "connectionId",
      "connectionGeneration",
      "providerInstanceId",
      "profileKey",
      "allocationId",
      "factoryId",
    ];
    if (
      Object.keys(provider).some((key) => !keys.includes(key)) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(provider.connectionId) ||
      !Number.isSafeInteger(provider.connectionGeneration) ||
      provider.connectionGeneration < 1 ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(provider.providerInstanceId) ||
      !/^[a-f0-9]{64}$/.test(provider.profileKey) ||
      !/^[a-f0-9-]{36}$/.test(provider.allocationId) ||
      !(provider.factoryId === null || /^[a-zA-Z0-9_-]{1,128}$/.test(provider.factoryId))
    )
      throw new Error("runtime_provider_binding");
    await writeJson(`${privateDirectory}/provider-binding.json`, { ...provider, ...binding });
    environment.FOUNDRY_PROVIDER_CONNECTION_BINDING_FILE = `${privateDirectory}/provider-binding.json`;
    environment.FOUNDRY_SANDBOX_ALLOCATION_ID = provider.allocationId;
    environment.FOUNDRY_WORKER_ENABLED = "true";
    environment.FOUNDRY_WORKER_CAPACITY = "1";
    environment.FOUNDRY_WORKER_PROVIDER_INSTANCE_ID = provider.providerInstanceId;
    environment.FOUNDRY_WORKER_WORKSPACE_ROOTS = JSON.stringify([workspaceDirectory]);
  }
  if (
    input.settings !== undefined &&
    (input.settings === null || typeof input.settings !== "object" || Array.isArray(input.settings))
  )
    throw new Error("runtime_settings");
  await NodeFSP.mkdir(`${privateDirectory}/t3/userdata`, { recursive: true, mode: 0o700 });
  await writeJson(`${privateDirectory}/t3/userdata/settings.json`, {
    ...input.settings,
    worktreesDirectory: `${workspaceDirectory}/worktrees`,
  });
  return environment;
};

export const restoreDeadline = (initial, maximum, now, stored) => {
  if (stored !== undefined && stored.maximum !== maximum) throw new Error("deadline_drift");
  return validateDeadline(stored?.expiresAt ?? initial, maximum, now);
};
const supervise = async (initial, maximum) => {
  const stored = (await exists(`${PRIVATE}/deadline.json`))
    ? await readJson(`${PRIVATE}/deadline.json`)
    : undefined;
  let deadline = restoreDeadline(initial, maximum, Date.now(), stored);
  let timer;
  let closing = false;
  const children = new Set();
  let started = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      process.exit(0);
    }, 15000);
    if (!children.size) process.exit(0);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
  };
  await writeJson(`${PRIVATE}/deadline.json`, { expiresAt: deadline, maximum });
  await writeJson(`${RUNTIME}/deadline.json`, { expiresAt: deadline, maximum });
  arm();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const spawn = (args, environment) => {
    const child = NodeChildProcess.spawn(process.execPath, [SERVER, ...args], {
      cwd: `${WORKSPACE}/repo`,
      env: {
        ...process.env,
        ...environment,
        HOME: `${WORKSPACE}/home`,
        CODEX_HOME: `${RUNTIME}/codex`,
        T3CODE_HOME: `${PRIVATE}/t3`,
      },
      stdio: "ignore",
    });
    children.add(child);
    child.once("error", stop);
    child.once("exit", () => {
      children.delete(child);
      stop();
    });
    return child;
  };
  let processing = Promise.resolve();
  const update = async () => {
    if (closing) return;
    const requested = await readJson(`${RUNTIME}/deadline.json`);
    deadline = validateDeadline(requested.expiresAt, maximum, Date.now());
    arm();
    if (!started && (await exists(`${RUNTIME}/runtime.json`))) {
      await requireSetup();
      const input = await readJson(`${RUNTIME}/runtime.json`);
      const identity = await ensureIdentity();
      const environment = await prepareRuntime(input, identity);
      await NodeFSP.mkdir(`${RUNTIME}/codex`, { recursive: true, mode: 0o700 });
      if (input.codexConfig !== undefined) {
        if (typeof input.codexConfig !== "string" || input.codexConfig.length > LIMIT)
          throw new Error("runtime_configuration");
        await NodeFSP.writeFile(`${RUNTIME}/codex/config.toml`, input.codexConfig, { mode: 0o600 });
      }
      const backend = spawn(
        ["--base-dir", `${PRIVATE}/t3`, "--host", "127.0.0.1", "--port", "3773", "--no-browser"],
        environment,
      );
      const connector = spawn(
        [
          "foundry",
          "connect-device",
          "--base-dir",
          `${PRIVATE}/t3`,
          "--origin",
          input.origin,
          "--registration",
          `${PRIVATE}/registration.json`,
          "--key-file",
          `${PRIVATE}/device-key.json`,
          "--gateway-origin",
          "http://127.0.0.1:3773",
          "--streams",
        ],
        environment,
      );
      started = true;
      await NodeFSP.rm(`${RUNTIME}/runtime.json`, { force: true });
      await writeJson(`${RUNTIME}/status.json`, {
        state: "started",
        backendPid: backend.pid,
        connectorPid: connector.pid,
      });
    }
  };
  const watcher = NodeFS.watch(RUNTIME, () => {
    processing = processing.then(update).catch(async () => {
      await writeJson(`${RUNTIME}/status.json`, { state: "failed", stage: "runtime" });
      stop();
    });
  });
  process.once("exit", () => watcher.close());
  await update();
};

const BUNDLE_INDEX_MIME = "application/vnd.foundry.git-bundle-index+json";
const BUNDLE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const BUNDLE_INDEX_MAX_BYTES = 1024 * 1024;
const decodeBundleIndex = (manifest, bytes) => {
  if (
    manifest?.mimeType !== BUNDLE_INDEX_MIME ||
    !manifest.reference?.instanceId ||
    !manifest.reference?.owner?.environmentId ||
    !manifest.reference?.owner?.threadId ||
    bytes.length > BUNDLE_INDEX_MAX_BYTES ||
    bytes.length !== manifest.sizeBytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new Error("bundle_index_mismatch");
  const index = JSON.parse(bytes.toString("utf8"));
  if (
    index.format !== "foundry-git-bundle-1" ||
    !Number.isSafeInteger(index.sizeBytes) ||
    index.sizeBytes < 1 ||
    index.sizeBytes > BUNDLE_MAX_BYTES ||
    typeof index.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(index.sha256) ||
    !Array.isArray(index.parts) ||
    index.parts.length < 1 ||
    index.parts.length > 1024
  )
    throw new Error("bundle_index_mismatch");
  const ids = new Set();
  let size = 0;
  for (const part of index.parts) {
    if (
      !Number.isSafeInteger(part.sizeBytes) ||
      part.sizeBytes < 1 ||
      part.sizeBytes > 8 * 1024 * 1024 ||
      typeof part.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(part.sha256) ||
      !part.reference?.artifactId ||
      ids.has(part.reference.artifactId) ||
      part.reference.instanceId !== manifest.reference?.instanceId ||
      part.reference.owner?.environmentId !== manifest.reference?.owner?.environmentId ||
      part.reference.owner?.threadId !== manifest.reference?.owner?.threadId
    )
      throw new Error("bundle_index_mismatch");
    ids.add(part.reference.artifactId);
    size += part.sizeBytes;
  }
  if (size !== index.sizeBytes) throw new Error("bundle_index_mismatch");
  return index;
};
const readBundleIndex = async (file, manifest) => {
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > BUNDLE_INDEX_MAX_BYTES)
      throw new Error("bundle_index_mismatch");
    const bytes = await handle.readFile();
    return { bytes, index: decodeBundleIndex(manifest, bytes) };
  } finally {
    await handle.close();
  }
};
export const writeResumeChunk = async (input, directory = PRIVATE) => {
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > BUNDLE_MAX_BYTES ||
    typeof input.base64 !== "string" ||
    input.base64.length > 350000
  )
    throw new Error("invalid_chunk");
  const bytes = Buffer.from(input.base64, "base64");
  if (
    bytes.toString("base64") !== input.base64 ||
    bytes.length > 256 * 1024 ||
    input.offset + bytes.length > BUNDLE_MAX_BYTES
  )
    throw new Error("invalid_chunk");
  const receiptPath = `${directory}/resume-receipt.json`;
  if (input.receipt !== undefined) {
    const encoded = JSON.stringify(input.receipt);
    if (input.offset !== 0 || encoded.length > 65536) throw new Error("invalid_receipt");
    if (await exists(receiptPath)) {
      if (JSON.stringify(await readJson(receiptPath)) !== encoded) throw new Error("resume_drift");
    } else await writeJson(receiptPath, input.receipt);
  }
  if (!(await exists(receiptPath))) throw new Error("receipt_required");
  const receipt = await readJson(receiptPath);
  const indexPath = `${directory}/resume-index.json`;
  if (input.indexBase64 !== undefined) {
    if (
      input.offset !== 0 ||
      typeof input.indexBase64 !== "string" ||
      input.indexBase64.length > 4 * Math.ceil(BUNDLE_INDEX_MAX_BYTES / 3)
    )
      throw new Error("bundle_index_mismatch");
    const encoded = Buffer.from(input.indexBase64, "base64");
    if (encoded.toString("base64") !== input.indexBase64) throw new Error("bundle_index_mismatch");
    decodeBundleIndex(receipt.manifest?.bundle, encoded);
    if (await exists(indexPath)) {
      if (!(await readBundleIndex(indexPath, receipt.manifest.bundle)).bytes.equals(encoded))
        throw new Error("resume_drift");
    } else await NodeFSP.writeFile(indexPath, encoded, { mode: 0o600, flag: "wx" });
  }
  const limit =
    receipt.manifest?.bundle?.mimeType === BUNDLE_INDEX_MIME
      ? (await readBundleIndex(indexPath, receipt.manifest.bundle)).index.sizeBytes
      : 50 * 1024 * 1024;
  if (input.offset + bytes.length > limit) throw new Error("invalid_chunk");
  const file = `${directory}/resume.bundle`;
  if (!(await exists(file))) await NodeFSP.writeFile(file, "", { mode: 0o600, flag: "wx" });
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || input.offset > stat.size)
    throw new Error("invalid_offset");
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDWR | NodeFS.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size
    )
      throw new Error("invalid_offset");
    if (input.offset < stat.size) {
      if (input.offset + bytes.length > stat.size) throw new Error("invalid_offset");
      const existing = Buffer.alloc(bytes.length);
      await handle.read(existing, 0, bytes.length, input.offset);
      if (!existing.equals(bytes)) throw new Error("resume_drift");
    } else await handle.write(bytes, 0, bytes.length, input.offset);
  } finally {
    await handle.close();
  }
  return { offset: Math.max(stat.size, input.offset + bytes.length) };
};
export const resume = async (
  paths = { workspace: WORKSPACE, private: PRIVATE, runtime: RUNTIME },
  run = execute,
) => {
  const receipt = await readJson(`${paths.private}/resume-receipt.json`);
  if (await exists(`${paths.private}/resumed.json`)) {
    const previous = await readJson(`${paths.private}/resumed.json`);
    if (previous.digest !== receipt.digest) throw new Error("resume_drift");
    if (!(await NodeFSP.lstat(`${paths.workspace}/repo`)).isDirectory())
      throw new Error("resume_workspace_missing");
    return previous;
  }
  if (
    (await exists(`${paths.runtime}/status.json`)) &&
    (await readJson(`${paths.runtime}/status.json`)).state === "started"
  )
    throw new Error("runtime_started");
  if (
    (await exists(`${paths.private}/setup.json`)) &&
    (await readJson(`${paths.private}/setup.json`)).state === "ready"
  )
    throw new Error("setup_before_resume");
  const multipart = receipt.manifest.bundle.mimeType === BUNDLE_INDEX_MIME;
  const expected = multipart
    ? (await readBundleIndex(`${paths.private}/resume-index.json`, receipt.manifest.bundle)).index
    : receipt.manifest.bundle;
  const handle = await NodeFSP.open(
    `${paths.private}/resume.bundle`,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== expected.sizeBytes ||
      stat.size > (multipart ? BUNDLE_MAX_BYTES : 50 * 1024 * 1024)
    )
      throw new Error("bundle_mismatch");
    const hash = NodeCrypto.createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      hash.digest("hex") !== expected.sha256
    )
      throw new Error("bundle_mismatch");
  } finally {
    await handle.close();
  }
  const stageFile = `${paths.private}/resume-stage.json`;
  const staging = `${paths.private}/resume-workspace`;
  const backup = `${paths.private}/initial-setup-repo`;
  let stage = (await exists(stageFile))
    ? await readJson(stageFile)
    : { digest: receipt.digest, state: "preparing" };
  if (stage.digest !== receipt.digest) throw new Error("resume_drift");
  await writeJson(stageFile, stage);
  for (const candidate of [staging, backup, `${paths.workspace}/repo`])
    if ((await exists(candidate)) && !(await NodeFSP.lstat(candidate)).isDirectory())
      throw new Error("unsafe_resume_path");
  if (stage.state === "preparing") {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    await NodeFSP.mkdir(staging, { mode: 0o700 });
    await run(
      [
        process.execPath,
        SERVER,
        "foundry",
        "sandbox-archive",
        "restore",
        "--base-dir",
        `${paths.private}/t3`,
        "--receipt",
        `${paths.private}/resume-receipt.json`,
        "--bundle",
        `${paths.private}/resume.bundle`,
        ...(multipart ? ["--bundle-index", `${paths.private}/resume-index.json`] : []),
        "--cwd",
        staging,
      ],
      paths.workspace,
      () => {},
    );
    stage = { ...stage, state: "restored", hadOriginal: await exists(`${paths.workspace}/repo`) };
    await writeJson(stageFile, stage);
  }
  if (stage.state === "restored") {
    if (stage.hadOriginal && !(await exists(backup)))
      await NodeFSP.rename(`${paths.workspace}/repo`, backup);
    stage = { ...stage, state: "installing" };
    await writeJson(stageFile, stage);
  }
  if (stage.state !== "installing") throw new Error("resume_stage");
  if (await exists(staging)) {
    if (await exists(`${paths.workspace}/repo`)) throw new Error("resume_destination_exists");
    await NodeFSP.rename(staging, `${paths.workspace}/repo`);
  }
  if (!(await exists(`${paths.workspace}/repo`))) throw new Error("resume_workspace_missing");
  const result = {
    digest: receipt.digest,
    source: receipt.manifest.owner,
    headCommit: receipt.manifest.headCommit,
    checkpointCommit: receipt.manifest.checkpointCommit,
    checkpointTree: receipt.manifest.checkpointTree,
  };
  await writeJson(`${paths.private}/resumed.json`, result);
  return result;
};
const readSetupChunk = async (input) => {
  if (
    input.part !== undefined &&
    (!Number.isSafeInteger(input.part) || input.part < 0 || input.part >= 1024)
  )
    throw new Error("snapshot_part");
  const file = `${PRIVATE}/setup-snapshot.json${input.part === undefined ? "" : `.part-${input.part}`}`;
  const stat = await NodeFSP.lstat(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 50 * 1024 * 1024 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > stat.size
  )
    throw new Error("snapshot_limit");
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(Math.min(256 * 1024, stat.size - input.offset));
    await handle.read(bytes, 0, bytes.length, input.offset);
    return {
      offset: input.offset,
      sizeBytes: stat.size,
      base64: bytes.toString("base64"),
      ...(input.offset === 0
        ? {
            sha256: NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(file))
              .digest("hex"),
          }
        : {}),
    };
  } finally {
    await handle.close();
  }
};

const main = async () => {
  await NodeFSP.mkdir(PRIVATE, { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  const mode = process.argv[2];
  if (mode === "supervise") return supervise(Number(process.argv[3]), Number(process.argv[4]));
  if (mode === "setup") return setup(await stdinJson());
  if (mode === "resume-chunk") return writeResumeChunk(await stdinJson());
  if (mode === "resume") return resume();
  if (mode === "read-setup-chunk") return readSetupChunk(await stdinJson());
  if (mode === "identity") return ensureIdentity();
  if (mode === "project") {
    await requireSetup();
    await execute(
      [
        process.execPath,
        SERVER,
        "project",
        "add",
        `${WORKSPACE}/repo`,
        "--base-dir",
        `${PRIVATE}/t3`,
      ],
      WORKSPACE,
    );
    return { state: "created" };
  }
  if (mode === "sign-enrollment") return signEnrollment(await stdinJson());
  if (mode === "runtime") {
    await requireSetup();
    if (
      (await exists(`${RUNTIME}/status.json`)) &&
      (await readJson(`${RUNTIME}/status.json`)).state === "started"
    )
      return { state: "started" };
    await writeJson(`${RUNTIME}/runtime.json`, await stdinJson());
    return { state: "requested" };
  }
  if (mode === "extend") {
    const { expiresAt } = await stdinJson();
    const current = await readJson(`${RUNTIME}/deadline.json`);
    validateDeadline(expiresAt, current.maximum, Date.now());
    if (expiresAt < current.expiresAt) throw new Error("deadline_reduction");
    await writeJson(`${PRIVATE}/deadline.json`, { ...current, expiresAt });
    await writeJson(`${RUNTIME}/deadline.json`, { ...current, expiresAt });
    return { expiresAt };
  }
  if (mode === "status")
    return {
      setup: await readJson(`${PRIVATE}/setup.json`).catch(() => null),
      runtime: await readJson(`${RUNTIME}/status.json`).catch(() => null),
      deadline: await readJson(`${RUNTIME}/deadline.json`),
    };
  if (mode === "read-archive") {
    const file = `${PRIVATE}/archive-manifest.json`;
    if ((await NodeFSP.stat(file)).size > 1024 * 1024) throw new Error("archive_limit");
    return readJson(file);
  }
  if (mode === "logs")
    return { log: (await NodeFSP.readFile(`${PRIVATE}/setup.log`, "utf8")).slice(-LIMIT) };
  throw new Error("invalid_command");
};

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => {
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
    })
    .catch(() => {
      process.stderr.write("Sandbox bootstrap command failed. Inspect setup status.\n");
      process.exitCode = 1;
    });
}
