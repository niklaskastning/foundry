// @effect-diagnostics nodeBuiltinImport:off -- Deterministic OCI resource names and spec fingerprints use SHA-256 at the process adapter boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";

const Identity = Schema.Struct({
  instanceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
  allocationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
});
const Provision = Schema.Struct({
  ...Identity.fields,
  image: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  ),
  architecture: Schema.Literals(["amd64", "arm64"]),
  cpuMillis: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 100, maximum: 64000 }),
  ),
  memoryMiB: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 128, maximum: 262144 }),
  ),
  pids: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 16, maximum: 4096 })),
  network: Schema.Literals(["none", "configured"]),
  command: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});
const Container = Schema.Struct({
  Id: Schema.String,
  Config: Schema.Struct({
    Image: Schema.optional(Schema.String),
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  State: Schema.Struct({
    Running: Schema.Boolean,
    Status: Schema.optional(Schema.String),
    ExitCode: Schema.optional(Schema.Number),
  }),
});
const Volume = Schema.Struct({
  Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});
const Network = Schema.Struct({
  Driver: Schema.String,
  Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});

const decodeIdentity = Schema.decodeUnknownEffect(Identity);
const decodeProvision = Schema.decodeUnknownEffect(Provision);
const decodeContainers = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Container)));
const decodeVolumes = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Volume)));
const decodeNetworks = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Network)));

export class OciError extends Schema.TaggedError<OciError>()("OciError", {
  operation: Schema.Literals([
    "validate",
    "inspect",
    "create",
    "start",
    "stop",
    "remove",
    "exec",
    "network",
  ]),
  reason: Schema.Literals([
    "invalid-input",
    "limit",
    "command",
    "response",
    "ownership",
    "drift",
    "running",
    "missing",
    "network-policy",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Sandbox OCI ${this.operation} failed (${this.reason}).`;
  }
}

export class OciSupervisor extends Context.Service<
  OciSupervisor,
  {
    readonly ensure: (input: typeof Provision.Type) => Effect.Effect<OciState, OciError>;
    readonly inspect: (identity: typeof Identity.Type) => Effect.Effect<OciState | null, OciError>;
    readonly stop: (identity: typeof Identity.Type) => Effect.Effect<OciState | null, OciError>;
    readonly remove: (identity: typeof Identity.Type) => Effect.Effect<void, OciError>;
    readonly finalize: (
      identity: typeof Identity.Type,
      input: { readonly argv: ReadonlyArray<string>; readonly stdin?: string },
    ) => Effect.Effect<
      | { readonly state: "running" }
      | {
          readonly state: "completed";
          readonly stdout: string;
          readonly stderr: string;
          readonly exitCode: number;
        },
      OciError
    >;
    readonly exec: (
      identity: typeof Identity.Type,
      input: {
        readonly argv: ReadonlyArray<string>;
        readonly stdin?: string;
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<
      { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
      OciError
    >;
  }
>()("t3/foundry/sandboxes/OciSupervisor") {}

type OciState = {
  readonly containerId: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly running: boolean;
  readonly status: string;
  readonly exitCode: number | null;
};

type Configuration = {
  readonly maxCpuMillis: number;
  readonly maxMemoryMiB: number;
  readonly maxPids: number;
  readonly networkName?: string;
  readonly controlTls?: {
    readonly hostname: string;
    readonly bridgeAddress: string;
    readonly publicCaPem: string;
  };
  readonly networkPolicyPath?: string;
  readonly executable?: string;
  readonly socketPath?: string;
};

const decodePolicy = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      action: Schema.Literal("inspect"),
      verified: Schema.Literal(true),
      control: Schema.optionalKey(Schema.NullOr(Schema.String)),
      dns: Schema.String.check(Schema.isPattern(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)),
    }),
  ),
);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Identity));
const ControlTls = Schema.Struct({
  hostname: Schema.String,
  bridgeAddress: Schema.String,
  caSha256: Schema.String,
});
const StoredProvision = Schema.fromJsonString(
  Schema.Struct({
    ...Provision.fields,
    resolvedNetwork: Schema.String,
    resolvedDns: Schema.NullOr(Schema.String),
    controlTls: Schema.optionalKey(Schema.NullOr(ControlTls)),
  }),
);
const encodeProvision = Schema.encodeSync(StoredProvision);
const decodeStoredProvision = Schema.decodeEffect(StoredProvision);

const names = (identity: typeof Identity.Type) => {
  const key = NodeCrypto.createHash("sha256").update(encodeIdentity(identity)).digest("hex");
  return { containerName: `foundry-sandbox-${key}`, volumeName: `foundry-workspace-${key}` };
};
const ownerLabels = (identity: typeof Identity.Type) => ({
  "com.foundry.kind": "sandbox-v1",
  "com.foundry.instance": identity.instanceId,
  "com.foundry.allocation": identity.allocationId,
});

const make = Effect.fn("OciSupervisor.make")(function* (configuration: Configuration) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const mutation = yield* Semaphore.make(1);
  const run = Effect.fn("OciSupervisor.command")(function* (
    operation: OciError["operation"],
    args: ReadonlyArray<string>,
    options?: { readonly stdin?: string; readonly timeoutMs?: number },
  ) {
    return yield* runner
      .run({
        command: configuration.executable ?? "/usr/bin/docker",
        args: [`--host=unix://${configuration.socketPath ?? "/var/run/docker.sock"}`, ...args],
        env: { DOCKER_CONTEXT: "", DOCKER_HOST: "", DOCKER_TLS_VERIFY: "", DOCKER_CERT_PATH: "" },
        cwd: "/",
        timeout: options?.timeoutMs ?? 120000,
        maxOutputBytes: 1024 * 1024,
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      })
      .pipe(Effect.mapError((cause) => new OciError({ operation, reason: "command", cause })));
  });
  const requireSuccess = Effect.fn("OciSupervisor.requireSuccess")(function* (
    operation: OciError["operation"],
    args: ReadonlyArray<string>,
  ) {
    const result = yield* run(operation, args);
    if (result.code !== 0) return yield* new OciError({ operation, reason: "command" });
    return result.stdout;
  });
  const validateIdentity = (identity: typeof Identity.Type) =>
    decodeIdentity(identity).pipe(
      Effect.mapError(
        (cause) => new OciError({ operation: "validate", reason: "invalid-input", cause }),
      ),
    );
  const verifyOwner = Effect.fn("OciSupervisor.verifyOwner")(function* (
    identity: typeof Identity.Type,
    labels: Readonly<Record<string, string>> | null,
    fingerprint?: string,
  ) {
    if (
      !labels ||
      Object.entries(ownerLabels(identity)).some(([key, value]) => labels[key] !== value)
    )
      return yield* new OciError({ operation: "inspect", reason: "ownership" });
    if (fingerprint !== undefined && labels["com.foundry.spec"] !== fingerprint)
      return yield* new OciError({ operation: "inspect", reason: "drift" });
  });
  const exists = Effect.fn("OciSupervisor.exists")(function* (
    kind: "container" | "volume",
    name: string,
  ) {
    const output = yield* requireSuccess("inspect", [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--format",
      kind === "container" ? "{{.Names}}" : "{{.Name}}",
      "--filter",
      `name=^${kind === "container" ? "/" : ""}${name}$`,
    ]);
    return output.split("\n").some((line) => line.trim() === name);
  });
  const inspectContainer = Effect.fn("OciSupervisor.inspectContainer")(function* (
    identity: typeof Identity.Type,
    fingerprint?: string,
    finalizer = false,
  ) {
    const originalNames = names(identity);
    const resourceNames = {
      ...originalNames,
      containerName: `${originalNames.containerName}${finalizer ? "-finalizer" : ""}`,
    };
    if (!(yield* exists("container", resourceNames.containerName))) return null;
    const json = yield* requireSuccess("inspect", [
      "container",
      "inspect",
      resourceNames.containerName,
    ]);
    const decoded = yield* decodeContainers(json).pipe(
      Effect.mapError((cause) => new OciError({ operation: "inspect", reason: "response", cause })),
    );
    const container = decoded[0];
    if (!container || decoded.length !== 1)
      return yield* new OciError({ operation: "inspect", reason: "response" });
    yield* verifyOwner(identity, container.Config.Labels, fingerprint);
    if (finalizer && container.Config.Labels?.["com.foundry.role"] !== "finalizer")
      return yield* new OciError({ operation: "inspect", reason: "ownership" });
    return {
      ...resourceNames,
      containerId: container.Id,
      running: container.State.Running,
      status: container.State.Status ?? (container.State.Running ? "running" : "stopped"),
      exitCode: container.State.ExitCode ?? null,
      provisioning: container.Config.Labels?.["com.foundry.provision"],
      image: container.Config.Image,
      finalizerDeadline: container.Config.Labels?.["com.foundry.finalizer-deadline"],
    };
  });
  const inspectVolume = Effect.fn("OciSupervisor.inspectVolume")(function* (
    identity: typeof Identity.Type,
    fingerprint?: string,
  ) {
    const name = names(identity).volumeName;
    if (!(yield* exists("volume", name))) return false;
    const json = yield* requireSuccess("inspect", ["volume", "inspect", name]);
    const decoded = yield* decodeVolumes(json).pipe(
      Effect.mapError((cause) => new OciError({ operation: "inspect", reason: "response", cause })),
    );
    if (decoded.length !== 1 || !decoded[0])
      return yield* new OciError({ operation: "inspect", reason: "response" });
    yield* verifyOwner(identity, decoded[0].Labels, fingerprint);
    return true;
  });
  const verifyNetwork = Effect.fn("OciSupervisor.verifyNetwork")(function* (
    network: string,
    control: typeof ControlTls.Type | null = null,
  ) {
    if (network === "none") return null;
    if (!/^foundry-sandbox-[a-z0-9-]+$/.test(network))
      return yield* new OciError({ operation: "network", reason: "network-policy" });
    const json = yield* requireSuccess("network", ["network", "inspect", network]);
    const decoded = yield* decodeNetworks(json).pipe(
      Effect.mapError((cause) => new OciError({ operation: "network", reason: "response", cause })),
    );
    if (
      decoded.length !== 1 ||
      decoded[0]?.Driver !== "bridge" ||
      decoded[0]?.Labels?.["com.foundry.egress-policy"] !== "restricted-v1"
    )
      return yield* new OciError({ operation: "network", reason: "network-policy" });
    const result = yield* runner
      .run({
        command: "/usr/bin/python3",
        args: [
          configuration.networkPolicyPath ?? "/usr/local/lib/foundry/sandbox/network-policy.py",
          "inspect",
          network,
        ],
        cwd: "/",
        timeout: 10000,
        maxOutputBytes: 4096,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OciError({ operation: "network", reason: "network-policy", cause }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated)
      return yield* new OciError({ operation: "network", reason: "network-policy" });
    const policy = yield* decodePolicy(result.stdout).pipe(
      Effect.mapError(
        (cause) => new OciError({ operation: "network", reason: "network-policy", cause }),
      ),
    );
    if (policy.name !== network || (control && policy.control !== `${control.bridgeAddress}:443`))
      return yield* new OciError({ operation: "network", reason: "network-policy" });
    return policy.dns;
  });
  const containerArguments = (
    spec: typeof Provision.Type,
    network: string,
    labels: ReadonlyArray<string>,
    name: string,
    argv: ReadonlyArray<string>,
    interactive = false,
    dns: string | null = null,
    control: typeof ControlTls.Type | null = null,
  ) => [
    "container",
    "create",
    "--name",
    name,
    ...labels,
    `--platform=linux/${spec.architecture}`,
    "--user=1000:1000",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--init",
    "--restart=no",
    `--cpus=${spec.cpuMillis / 1000}`,
    `--memory=${spec.memoryMiB}m`,
    `--memory-swap=${spec.memoryMiB}m`,
    `--pids-limit=${spec.pids}`,
    "--ulimit=nofile=4096:4096",
    "--log-driver=none",
    `--network=${network}`,
    ...(dns ? [`--dns=${dns}`] : []),
    ...(control
      ? [
          `--add-host=${control.hostname}:${control.bridgeAddress}`,
          ...(interactive ? ["--env=NODE_EXTRA_CA_CERTS=/workspace/.foundry/control-ca.pem"] : []),
          `--env=FOUNDRY_SANDBOX_CONTROL_CA_SHA256=${control.caSha256}`,
        ]
      : []),
    "--ipc=private",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=67108864,mode=1777",
    "--tmpfs=/run:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700",
    "--mount",
    `type=volume,src=${names(spec).volumeName},dst=/workspace`,
    "--workdir=/workspace",
    "--env=HOME=/workspace/home",
    `--env=FOUNDRY_SANDBOX_ALLOCATION_ID=${spec.allocationId}`,
    "--env=FOUNDRY_WORKER_ARTIFACT_BINDING_FILE=/workspace/.foundry/artifact-binding.json",
    ...(interactive ? ["--interactive"] : []),
    "--entrypoint",
    argv[0]!,
    spec.image,
    ...argv.slice(1),
  ];
  const inspect: OciSupervisor["Service"]["inspect"] = Effect.fn("OciSupervisor.inspect")(
    function* (identity) {
      yield* validateIdentity(identity);
      return yield* inspectContainer(identity);
    },
  );
  const ensure: OciSupervisor["Service"]["ensure"] = Effect.fn("OciSupervisor.ensure")(function* (
    input,
  ) {
    const spec = yield* decodeProvision(input).pipe(
      Effect.mapError(
        (cause) => new OciError({ operation: "validate", reason: "invalid-input", cause }),
      ),
    );
    if (
      spec.cpuMillis > configuration.maxCpuMillis ||
      spec.memoryMiB > configuration.maxMemoryMiB ||
      spec.pids > configuration.maxPids
    )
      return yield* new OciError({ operation: "validate", reason: "limit" });
    const network = spec.network === "configured" ? (configuration.networkName ?? "") : "none";
    const controlTls =
      network !== "none" && configuration.controlTls
        ? yield* Effect.try({
            try: () => {
              const control = configuration.controlTls!;
              if (
                !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(control.hostname) ||
                NodeNet.isIP(control.bridgeAddress) !== 4 ||
                control.publicCaPem.length > 16384 ||
                !/^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(
                  control.publicCaPem,
                )
              )
                throw new Error("control_tls");
              const certificate = new NodeCrypto.X509Certificate(control.publicCaPem);
              if (!certificate.ca) throw new Error("control_ca");
              return {
                hostname: control.hostname,
                bridgeAddress: control.bridgeAddress,
                caSha256: NodeCrypto.createHash("sha256").update(certificate.raw).digest("hex"),
              };
            },
            catch: (cause) =>
              new OciError({ operation: "network", reason: "network-policy", cause }),
          })
        : null;
    const dns = yield* verifyNetwork(network, controlTls);
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(
        encodeProvision({
          ...spec,
          resolvedNetwork: network,
          resolvedDns: dns,
          ...(controlTls ? { controlTls } : {}),
        }),
      )
      .digest("hex");
    const labels = Object.entries({
      ...ownerLabels(spec),
      "com.foundry.spec": fingerprint,
      "com.foundry.provision": encodeProvision({
        ...spec,
        resolvedNetwork: network,
        resolvedDns: dns,
        ...(controlTls ? { controlTls } : {}),
      }),
    }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    const resourceNames = names(spec);
    const finalizer = yield* inspectContainer(spec, fingerprint, true);
    if (finalizer?.running) return yield* new OciError({ operation: "start", reason: "running" });
    let current = yield* inspectContainer(spec, fingerprint);
    if (!(yield* inspectVolume(spec, fingerprint))) {
      yield* run("create", ["volume", "create", ...labels, resourceNames.volumeName]);
      if (!(yield* inspectVolume(spec, fingerprint)))
        return yield* new OciError({ operation: "create", reason: "missing" });
    }
    if (!current) {
      yield* run(
        "create",
        containerArguments(
          spec,
          network,
          labels,
          resourceNames.containerName,
          spec.command,
          false,
          dns,
          controlTls,
        ),
      );
      current = yield* inspectContainer(spec, fingerprint);
      if (!current) return yield* new OciError({ operation: "create", reason: "missing" });
    }
    if (!current.running) {
      yield* run("start", ["container", "start", current.containerId]);
      current = yield* inspectContainer(spec, fingerprint);
      if (!current?.running) return yield* new OciError({ operation: "start", reason: "command" });
    }
    return current;
  }, mutation.withPermits(1));
  const stop: OciSupervisor["Service"]["stop"] = Effect.fn("OciSupervisor.stop")(function* (
    identity,
  ) {
    yield* validateIdentity(identity);
    let current = yield* inspectContainer(identity);
    if (current?.running) {
      yield* run("stop", ["container", "stop", "--time=15", current.containerId]);
      current = yield* inspectContainer(identity);
      if (current?.running) return yield* new OciError({ operation: "stop", reason: "running" });
    }
    return current;
  }, mutation.withPermits(1));
  const remove: OciSupervisor["Service"]["remove"] = Effect.fn("OciSupervisor.remove")(function* (
    identity,
  ) {
    yield* validateIdentity(identity);
    const current = yield* inspectContainer(identity);
    const volumeExists = yield* inspectVolume(identity);
    const finalizer = yield* inspectContainer(identity, undefined, true);
    if (finalizer?.running) return yield* new OciError({ operation: "remove", reason: "running" });
    if (finalizer) yield* requireSuccess("remove", ["container", "rm", finalizer.containerId]);
    if (current?.running) return yield* new OciError({ operation: "remove", reason: "running" });
    if (current) {
      yield* run("remove", ["container", "rm", current.containerId]);
      if (yield* inspectContainer(identity))
        return yield* new OciError({ operation: "remove", reason: "command" });
    }
    if (volumeExists) {
      yield* run("remove", ["volume", "rm", names(identity).volumeName]);
      if (yield* inspectVolume(identity))
        return yield* new OciError({ operation: "remove", reason: "command" });
    }
  }, mutation.withPermits(1));
  const exec: OciSupervisor["Service"]["exec"] = Effect.fn("OciSupervisor.exec")(
    function* (identity, input) {
      yield* validateIdentity(identity);
      if (
        !input.argv.length ||
        input.argv.length > 64 ||
        input.argv.some((arg) => arg.length > 4096 || arg.includes("\0")) ||
        (input.stdin?.length ?? 0) > 4 * 1024 * 1024 ||
        (input.timeoutMs !== undefined &&
          (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600000))
      )
        return yield* new OciError({ operation: "validate", reason: "invalid-input" });
      const current = yield* inspectContainer(identity);
      if (!current?.running) return yield* new OciError({ operation: "exec", reason: "missing" });
      const result = yield* run(
        "exec",
        [
          "container",
          "exec",
          "--user=1000:1000",
          ...(input.stdin !== undefined ? ["--interactive"] : []),
          current.containerId,
          ...input.argv,
        ],
        input,
      );
      if (result.code === null)
        return yield* new OciError({ operation: "exec", reason: "command" });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: Number(result.code) };
    },
  );
  const finalize: OciSupervisor["Service"]["finalize"] = Effect.fn("OciSupervisor.finalize")(
    function* (identity, input) {
      yield* validateIdentity(identity);
      const archiveCommand =
        input.argv[0] === "node" &&
        input.argv[1] === "/app/dist/bin.mjs" &&
        input.argv[2] === "foundry" &&
        input.argv[3] === "sandbox-archive";
      const readCommand =
        input.argv.length === 3 &&
        input.argv[0] === "node" &&
        input.argv[1] === "/app/foundry-sandbox-bootstrap.mjs" &&
        ["read-archive", "read-setup-chunk"].includes(input.argv[2]!);
      if (
        (!archiveCommand && !readCommand) ||
        input.argv.length > 64 ||
        input.argv.some((arg) => arg.length > 4096 || arg.includes("\0")) ||
        (input.stdin?.length ?? 0) > 4 * 1024 * 1024
      )
        return yield* new OciError({ operation: "validate", reason: "invalid-input" });
      const current = yield* inspectContainer(identity);
      if (!current || current.running || !current.provisioning)
        return yield* new OciError({
          operation: "exec",
          reason: current?.running ? "running" : "missing",
        });
      const spec = yield* decodeStoredProvision(current.provisioning).pipe(
        Effect.mapError(
          (cause) => new OciError({ operation: "inspect", reason: "response", cause }),
        ),
      );
      if (
        spec.instanceId !== identity.instanceId ||
        spec.allocationId !== identity.allocationId ||
        (current.image !== undefined && current.image !== spec.image)
      )
        return yield* new OciError({ operation: "inspect", reason: "ownership" });
      const verifiedDns = yield* verifyNetwork(spec.resolvedNetwork, spec.controlTls);
      if (verifiedDns !== spec.resolvedDns)
        return yield* new OciError({ operation: "network", reason: "network-policy" });
      const fingerprint = NodeCrypto.createHash("sha256")
        .update(encodeProvision(spec))
        .digest("hex");
      yield* inspectContainer(identity, fingerprint);
      if (!(yield* inspectVolume(identity, fingerprint)))
        return yield* new OciError({ operation: "exec", reason: "missing" });
      const old = yield* inspectContainer(identity, fingerprint, true);
      const now = yield* Clock.currentTimeMillis;
      if (old?.running) {
        const deadline = Number(old.finalizerDeadline);
        if (!Number.isSafeInteger(deadline))
          return yield* new OciError({ operation: "inspect", reason: "response" });
        if (deadline > now) return { state: "running" as const };
        yield* requireSuccess("stop", ["container", "stop", "--time=15", old.containerId]);
        if ((yield* inspectContainer(identity, fingerprint, true))?.running)
          return yield* new OciError({ operation: "stop", reason: "running" });
      }
      if (old) yield* requireSuccess("remove", ["container", "rm", old.containerId]);
      const name = `${current.containerName}-finalizer`;
      const labels = Object.entries({
        ...ownerLabels(identity),
        "com.foundry.spec": fingerprint,
        "com.foundry.role": "finalizer",
        "com.foundry.finalizer-deadline": String(now + 600000),
      }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
      yield* requireSuccess(
        "create",
        containerArguments(
          spec,
          spec.resolvedNetwork,
          labels,
          name,
          input.argv,
          true,
          spec.resolvedDns,
          spec.controlTls,
        ),
      );
      const helper = yield* inspectContainer(identity, fingerprint, true);
      if (!helper) return yield* new OciError({ operation: "exec", reason: "missing" });
      const result = yield* run(
        "exec",
        ["container", "start", "--attach", "--interactive", helper.containerId],
        { ...input, timeoutMs: 600000 },
      ).pipe(
        Effect.onError(() =>
          run("stop", ["container", "stop", "--time=15", helper.containerId]).pipe(Effect.ignore),
        ),
      );
      const ended = yield* inspectContainer(identity, fingerprint, true);
      if (ended?.running) return { state: "running" as const };
      if (ended) yield* requireSuccess("remove", ["container", "rm", ended.containerId]);
      if (result.code === null)
        return yield* new OciError({ operation: "exec", reason: "command" });
      return {
        state: "completed" as const,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: Number(result.code),
      };
    },
    mutation.withPermits(1),
  );
  return OciSupervisor.of({ ensure, inspect, stop, remove, exec, finalize });
});

export const layer = (configuration: Configuration) =>
  Layer.effect(OciSupervisor, make(configuration));
