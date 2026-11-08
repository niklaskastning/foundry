// @effect-diagnostics nodeBuiltinImport:off -- Bootstrap fixtures use isolated directories to verify pinned checkout state across restart.
import { TEST_SANDBOX_CA } from "./tls.fixture.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  setup,
  resume,
  validateDeadline,
  versionMatches,
  prepareRuntime,
  restoreDeadline,
  writeResumeChunk,
} from "./bootstrap.mjs";

it("pins setup and tool versions, retries a failed setup, and preserves successful setup on restart", async () => {
  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-bootstrap-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(workspace, { recursive: true, force: true }),
  };
  const paths = { workspace, private: NodePath.join(workspace, ".foundry") };
  const input = {
    repositoryUrl: "https://example.com/owner/repo",
    revision: "a".repeat(40),
    setup: [["fixture-setup"]],
    tools: [{ command: "node", version: "26.12.1" }],
  };
  let failures = 1;
  const calls: string[][] = [];
  const run = async (argv: string[], _cwd: string, output: (text: string) => void) => {
    calls.push(argv);
    if (argv.includes("rev-parse")) return input.revision;
    if (argv[0] === "fixture-setup" && failures-- > 0) {
      output("expected setup failure");
      throw new Error("failure");
    }
    if (argv[0] === "node") return "v26.12.1";
    return "";
  };
  await expect(setup(input, paths, run)).rejects.toThrow("setup");
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(paths.private, "setup.json"), "utf8")),
  ).toMatchObject({ state: "failed", stage: "setup" });
  const result = await setup(input, paths, run);
  expect(result).toMatchObject({ state: "ready", revision: input.revision, tools: input.tools });
  const completedCount = calls.length;
  expect(await setup(input, paths, run)).toEqual(result);
  expect(calls).toHaveLength(completedCount);
  await expect(setup({ ...input, revision: "b".repeat(40) }, paths, run)).rejects.toThrow(
    "setup_drift",
  );
  expect(versionMatches("v26.12.10", "26.12.1")).toBe(false);
  expect(versionMatches("codex-cli 0.114.0", "0.114.0")).toBe(true);
});

it("rejects a mismatched fetched commit before setup and rejects deadlines beyond the initial maximum", async () => {
  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-bootstrap-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(workspace, { recursive: true, force: true }),
  };
  const paths = { workspace, private: NodePath.join(workspace, ".foundry") };
  let setupCalls = 0;
  await expect(
    setup(
      {
        repositoryUrl: "https://example.com/owner/repo",
        revision: "a".repeat(40),
        setup: [["setup"]],
        tools: [],
      },
      paths,
      async (argv: string[]) => {
        if (argv[0] === "setup") setupCalls++;
        return argv.includes("rev-parse") ? "b".repeat(40) : "";
      },
    ),
  ).rejects.toThrow("checkout");
  expect(setupCalls).toBe(0);
  expect(validateDeadline(1500, 2000, 1000)).toBe(1500);
  expect(restoreDeadline(1500, 2000, 1600, { expiresAt: 1900, maximum: 2000 })).toBe(1900);
  expect(() => restoreDeadline(1500, 2000, 1600, { expiresAt: 1900, maximum: 2100 })).toThrow(
    "deadline_drift",
  );
  expect(() => restoreDeadline(1500, 2000, 1901, { expiresAt: 1900, maximum: 2000 })).toThrow(
    "invalid_deadline",
  );
  expect(() => validateDeadline(2001, 2000, 1000)).toThrow("invalid_deadline");
  expect(() => validateDeadline(999, 2000, 1000)).toThrow("invalid_deadline");
});

it("materializes only fixed device binding paths and rejects runtime secrets and a foreign identity", async () => {
  const privateDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "foundry-runtime-binding-"),
  );
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(privateDirectory, { recursive: true, force: true }),
  };
  const identity = { environmentId: "sandbox-environment", publicKey: "public-key" };
  const input = {
    origin: "https://foundry.example",
    registration: identity,
    providerBinding: {
      connectionId: "central",
      connectionGeneration: 1,
      providerInstanceId: "codex",
      profileKey: "a".repeat(64),
      allocationId: "11111111-1111-4111-8111-111111111111",
      factoryId: null,
    },
  };
  const environment = await prepareRuntime(input, identity, privateDirectory);
  expect(environment.FOUNDRY_WORKER_ENABLED).toBe("true");
  const binding = JSON.parse(
    await NodeFSP.readFile(environment.FOUNDRY_PROVIDER_CONNECTION_BINDING_FILE!, "utf8"),
  );
  expect(binding).toMatchObject({
    ...input.providerBinding,
    registrationFile: `${privateDirectory}/registration.json`,
    keyFile: `${privateDirectory}/device-key.json`,
  });
  await expect(
    prepareRuntime(
      { ...input, environment: { OPENAI_API_KEY: "must-not-copy" } },
      identity,
      privateDirectory,
    ),
  ).rejects.toThrow("runtime_environment");
  await expect(
    prepareRuntime(
      { ...input, registration: { ...identity, environmentId: "foreign" } },
      identity,
      privateDirectory,
    ),
  ).rejects.toThrow("runtime_identity");
  expect(
    (await NodeFSP.stat(environment.FOUNDRY_PROVIDER_CONNECTION_BINDING_FILE!)).mode & 0o777,
  ).toBe(0o600);
});

it("resumes chunk transfer after a lost receipt without overwriting different bytes or another receipt", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-resume-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
  const first = {
    offset: 0,
    base64: Buffer.from("first").toString("base64"),
    receipt: { digest: "pinned" },
  };
  expect(await writeResumeChunk(first, directory)).toEqual({ offset: 5 });
  expect(await writeResumeChunk(first, directory)).toEqual({ offset: 5 });
  await expect(
    writeResumeChunk({ ...first, receipt: { digest: "changed" } }, directory),
  ).rejects.toThrow("resume_drift");
  await expect(
    writeResumeChunk({ ...first, base64: Buffer.from("other").toString("base64") }, directory),
  ).rejects.toThrow("resume_drift");
  await expect(writeResumeChunk({ offset: 9, base64: "" }, directory)).rejects.toThrow(
    "invalid_offset",
  );
  expect(
    await writeResumeChunk(
      { offset: 5, base64: Buffer.from("-last").toString("base64") },
      directory,
    ),
  ).toEqual({ offset: 10 });
  expect(await NodeFSP.readFile(`${directory}/resume.bundle`, "utf8")).toBe("first-last");
});

it("assembles a multipart resume beyond the artifact limit while rejecting changed indexes and oversized writes", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-large-resume-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
  const prefixBytes = 50 * 1024 * 1024 + 1;
  const reference = { instanceId: "instance", owner: { environmentId: "old", threadId: "thread" } };
  const index = {
    format: "foundry-git-bundle-1",
    sizeBytes: prefixBytes + 4,
    sha256: "a".repeat(64),
    parts: Array.from({ length: 7 }, (_, part) => ({
      reference: { ...reference, artifactId: `part-${part}` },
      name: `part-${part}`,
      mimeType: "application/octet-stream",
      sizeBytes: part === 6 ? prefixBytes + 4 - 6 * 8 * 1024 * 1024 : 8 * 1024 * 1024,
      sha256: "b".repeat(64),
    })),
  };
  const encoded = Buffer.from(JSON.stringify(index));
  const receipt = {
    digest: "pinned",
    manifest: {
      bundle: {
        reference: { ...reference, artifactId: "index" },
        mimeType: "application/vnd.foundry.git-bundle-index+json",
        sizeBytes: encoded.length,
        sha256: NodeCrypto.createHash("sha256").update(encoded).digest("hex"),
      },
    },
  };
  await writeResumeChunk(
    { offset: 0, base64: "", receipt, indexBase64: encoded.toString("base64") },
    directory,
  );
  const file = await NodeFSP.open(`${directory}/resume.bundle`, "r+");
  try {
    await file.truncate(prefixBytes);
  } finally {
    await file.close();
  }
  expect(
    await writeResumeChunk(
      { offset: prefixBytes, base64: Buffer.from("tail").toString("base64") },
      directory,
    ),
  ).toEqual({ offset: prefixBytes + 4 });
  await expect(
    writeResumeChunk(
      { offset: prefixBytes + 4, base64: Buffer.from("x").toString("base64") },
      directory,
    ),
  ).rejects.toThrow("invalid_chunk");
  await expect(
    writeResumeChunk(
      {
        offset: 0,
        base64: "",
        receipt,
        indexBase64: Buffer.from(JSON.stringify({ ...index, sha256: "c".repeat(64) })).toString(
          "base64",
        ),
      },
      directory,
    ),
  ).rejects.toThrow("bundle_index_mismatch");
});

it.each([false, true])(
  "restores before setup and preserves archived edits, dependencies and skills across restart (initial directory: %s)",
  async (initialDirectory) => {
    const workspace = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "foundry-resume-setup-"),
    );
    await using _cleanup = {
      [Symbol.asyncDispose]: () => NodeFSP.rm(workspace, { recursive: true, force: true }),
    };
    const paths = {
      workspace,
      private: NodePath.join(workspace, ".foundry"),
      runtime: NodePath.join(workspace, ".run"),
    };
    await NodeFSP.mkdir(paths.private);
    if (initialDirectory) await NodeFSP.mkdir(NodePath.join(workspace, "repo"));
    const source = NodePath.join(workspace, "source");
    const git = NodeUtil.promisify(NodeChildProcess.execFile);
    await git("git", ["init", "--quiet", source]);
    await NodeFSP.writeFile(NodePath.join(source, "work.txt"), "archived edits");
    await git("git", ["-C", source, "add", "work.txt"]);
    await git("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "Archived work",
    ]);
    const head = (await git("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    const bundlePath = NodePath.join(workspace, "source.bundle");
    await git("git", ["-C", source, "bundle", "create", bundlePath, "--all"]);
    const bundle = await NodeFSP.readFile(bundlePath);
    const part = {
      reference: {
        instanceId: "instance",
        artifactId: "part",
        owner: { environmentId: "old", threadId: "thread" },
      },
      name: "bundle-part",
      mimeType: "application/octet-stream",
      sizeBytes: bundle.length,
      sha256: NodeCrypto.createHash("sha256").update(bundle).digest("hex"),
    };
    const encodedIndex = Buffer.from(
      JSON.stringify({
        format: "foundry-git-bundle-1",
        sizeBytes: bundle.length,
        sha256: part.sha256,
        parts: [part],
      }),
    );
    const receipt = {
      digest: "source-receipt",
      manifest: {
        owner: { environmentId: "old", threadId: "thread" },
        headCommit: head,
        checkpointCommit: head,
        checkpointTree: "d".repeat(40),
        bundle: initialDirectory
          ? {
              ...part,
              reference: { ...part.reference, artifactId: "index" },
              mimeType: "application/vnd.foundry.git-bundle-index+json",
              sizeBytes: encodedIndex.length,
              sha256: NodeCrypto.createHash("sha256").update(encodedIndex).digest("hex"),
            }
          : part,
      },
    };
    await writeResumeChunk(
      {
        offset: 0,
        base64: bundle.toString("base64"),
        receipt,
        ...(initialDirectory ? { indexBase64: encodedIndex.toString("base64") } : {}),
      },
      paths.private,
    );
    const restore = async (argv: string[]) => {
      expect(argv.includes("--bundle-index")).toBe(initialDirectory);
      const cwd = argv[argv.indexOf("--cwd") + 1]!;
      await git("git", ["clone", "--quiet", NodePath.join(paths.private, "resume.bundle"), cwd]);
      return "";
    };
    const result = await resume(paths, restore);
    expect(result.source).toEqual(receipt.manifest.owner);
    // Simulate a restart after the workspace rename but before the durable receipt.
    await NodeFSP.rm(NodePath.join(paths.private, "resumed.json"));
    expect(await resume(paths, restore)).toEqual(result);
    const input = {
      repositoryUrl: "https://example.com/owner/repo",
      revision: "a".repeat(40),
      setup: [["install-dependencies"]],
      tools: [{ command: "local-tool", version: "1.2.3" }],
      skills: [
        {
          id: "fixture",
          directory: ".agents/fixture",
          name: "Fixture",
          description: "Fixture skill",
          files: [
            {
              path: "SKILL.md",
              content: "profile skill",
              encoding: "utf8" as const,
              mode: "100644" as const,
              sha256: NodeCrypto.createHash("sha256").update("profile skill").digest("hex"),
            },
          ],
        },
      ],
    };
    let failInstall = true;
    const install = async (argv: string[], cwd: string) => {
      if (argv[0] === "git") throw new Error("must not overwrite archived checkout");
      expect(await NodeFSP.readFile(NodePath.join(cwd, "work.txt"), "utf8")).toBe("archived edits");
      if (argv[0] === "install-dependencies") {
        if (failInstall) {
          failInstall = false;
          throw new Error("retry setup");
        }
        await NodeFSP.mkdir(NodePath.join(cwd, "node_modules"));
        await NodeFSP.writeFile(NodePath.join(cwd, "node_modules", "tool"), "1.2.3");
      }
      if (argv[0] === "local-tool")
        return await NodeFSP.readFile(NodePath.join(cwd, "node_modules", "tool"), "utf8");
      if (argv.includes("sandbox-skills")) {
        await NodeFSP.mkdir(NodePath.join(cwd, ".agents"));
        await NodeFSP.writeFile(NodePath.join(cwd, ".agents", "SKILL.md"), "profile skill");
      }
      return "";
    };
    await expect(setup(input, paths, install)).rejects.toThrow("setup");
    await resume(paths, restore);
    await setup(input, paths, install);
    await resume(paths, restore);
    await setup(input, paths, install);
    expect(await NodeFSP.readFile(NodePath.join(workspace, "repo", "work.txt"), "utf8")).toBe(
      "archived edits",
    );
    expect(
      await NodeFSP.readFile(NodePath.join(workspace, "repo", "node_modules", "tool"), "utf8"),
    ).toBe("1.2.3");
    expect(
      await NodeFSP.readFile(NodePath.join(workspace, "repo", ".agents", "SKILL.md"), "utf8"),
    ).toBe("profile skill");
  },
);

it("keeps pinned checkout history complete so an archive restores into an empty repository", async () => {
  const workspace = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "foundry-checkout-history-"),
  );
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(workspace, { recursive: true, force: true }),
  };
  const git = NodeUtil.promisify(NodeChildProcess.execFile);
  const source = NodePath.join(workspace, "source");
  await git("git", ["init", "--quiet", source]);
  await NodeFSP.writeFile(NodePath.join(source, "work.txt"), "original");
  await git("git", ["-C", source, "add", "work.txt"]);
  const commit = [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-am",
    "work",
  ];
  await git("git", commit);
  const first = (await git("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await NodeFSP.writeFile(NodePath.join(source, "work.txt"), "archived second commit");
  await git("git", commit);
  const revision = (await git("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const repositoryUrl = "https://fixture.example/owner/repo";
  await setup(
    { repositoryUrl, revision, setup: [], tools: [] },
    { workspace, private: NodePath.join(workspace, ".foundry") },
    async (argv, cwd) => {
      const args = argv
        .slice(1)
        .map((arg) =>
          arg === repositoryUrl
            ? `file://${source}`
            : arg === "protocol.file.allow=never"
              ? "protocol.file.allow=always"
              : arg,
        );
      return (await git(argv[0]!, args, { cwd })).stdout.trim();
    },
  );
  const bundle = NodePath.join(workspace, "archive.bundle");
  await git("git", ["-C", NodePath.join(workspace, "repo"), "bundle", "create", bundle, "HEAD"]);
  const restored = NodePath.join(workspace, "restored");
  await git("git", ["init", "--quiet", restored]);
  await git("git", ["-C", restored, "fetch", bundle, "HEAD"]);
  await git("git", ["-C", restored, "checkout", "--quiet", "FETCH_HEAD"]);
  await git("git", ["-C", restored, "merge-base", "--is-ancestor", first, revision]);
  expect(await NodeFSP.readFile(NodePath.join(restored, "work.txt"), "utf8")).toBe(
    "archived second commit",
  );
});

it("installs local package files as copies with the actual package manager and an isolated offline store", async () => {
  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-package-copy-"));
  await using _cleanup = {
    [Symbol.asyncDispose]: () => NodeFSP.rm(workspace, { recursive: true, force: true }),
  };
  const run = NodeUtil.promisify(NodeChildProcess.execFile);
  const packed = NodePath.join(workspace, "packed");
  const project = NodePath.join(workspace, "repo");
  const privateDirectory = NodePath.join(workspace, ".foundry");
  for (const directory of [
    NodePath.join(packed, "package"),
    project,
    privateDirectory,
    NodePath.join(workspace, "home"),
  ])
    await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(packed, "package", "package.json"),
    JSON.stringify({ name: "foundry-offline-fixture", version: "1.0.0", main: "index.js" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(packed, "package", "index.js"),
    "module.exports = 'copied fixture';\n",
  );
  const tarball = NodePath.join(workspace, "fixture.tgz");
  await run("tar", ["-czf", tarball, "-C", packed, "package"]);
  await NodeFSP.writeFile(
    NodePath.join(project, "package.json"),
    JSON.stringify({
      name: "sandbox-installer-fixture",
      private: true,
      dependencies: { "foundry-offline-fixture": "file:../fixture.tgz" },
    }),
  );
  const config = NodePath.join(workspace, "empty.npmrc");
  await NodeFSP.writeFile(config, "");
  const identity = { environmentId: "sandbox", publicKey: "fixture-key" };
  const runtime = await prepareRuntime(
    { origin: "https://foundry.example", registration: identity },
    identity,
    privateDirectory,
    workspace,
  );
  await run(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--store-dir", NodePath.join(workspace, "store")],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: NodePath.join(workspace, "home"),
        XDG_CACHE_HOME: NodePath.join(workspace, "cache"),
        XDG_CONFIG_HOME: NodePath.join(workspace, "config"),
        XDG_DATA_HOME: NodePath.join(workspace, "data"),
        npm_config_userconfig: config,
        npm_config_globalconfig: config,
        COREPACK_ENABLE_NETWORK: "0",
        PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
        npm_config_package_import_method: "hardlink",
        pnpm_config_package_import_method: "hardlink",
        ...runtime,
      },
    },
  );
  const installed = NodePath.join(project, "node_modules", "foundry-offline-fixture", "index.js");
  expect(await NodeFSP.readFile(installed, "utf8")).toBe("module.exports = 'copied fixture';\n");
  expect((await NodeFSP.stat(installed)).nlink).toBe(1);
});

it("trusts only the public control CA pinned by OCI and retains it for archive helpers", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-control-ca-"));
  const previous = process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256;
  await using _cleanup = {
    [Symbol.asyncDispose]: async () => {
      if (previous === undefined) delete process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256;
      else process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256 = previous;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
  const identity = { environmentId: "sandbox", publicKey: "fixture" };
  const input = {
    origin: "https://foundry.example",
    registration: identity,
    controlCaPem: TEST_SANDBOX_CA,
  };
  delete process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256;
  await expect(prepareRuntime(input, identity, directory)).rejects.toThrow("runtime_control_ca");
  process.env.FOUNDRY_SANDBOX_CONTROL_CA_SHA256 = NodeCrypto.createHash("sha256")
    .update(new NodeCrypto.X509Certificate(TEST_SANDBOX_CA).raw)
    .digest("hex");
  const environment = await prepareRuntime(input, identity, directory);
  expect(await NodeFSP.readFile(environment.NODE_EXTRA_CA_CERTS!, "utf8")).toBe(TEST_SANDBOX_CA);
  expect((await NodeFSP.stat(environment.NODE_EXTRA_CA_CERTS!)).mode & 0o777).toBe(0o600);
  await expect(
    prepareRuntime({ ...input, controlCaPem: "-----BEGIN PRIVATE KEY-----" }, identity, directory),
  ).rejects.toThrow("runtime_control_ca");
  await expect(
    prepareRuntime({ origin: input.origin, registration: identity }, identity, directory),
  ).rejects.toThrow("runtime_control_ca_required");
});
