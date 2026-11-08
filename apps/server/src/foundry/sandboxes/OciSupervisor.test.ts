// @effect-diagnostics nodeBuiltinImport:off -- Fixture Docker responses preserve the real policy bytes and legacy SHA-256 labels.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { TEST_SANDBOX_CA } from "./tls.fixture.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../../processRunner.ts";
import * as OciSupervisor from "./OciSupervisor.ts";

const input = {
  instanceId: "instance-one",
  allocationId: "allocation-one",
  image: `ghcr.io/example/runtime@sha256:${"a".repeat(64)}`,
  architecture: "amd64" as const,
  cpuMillis: 1000,
  memoryMiB: 512,
  pids: 128,
  network: "none" as const,
  command: ["node", "/app/sandbox.mjs"],
};

const seccompPolicy = JSON.stringify(
  JSON.parse(
    NodeFS.readFileSync(
      new URL("../../../../../deploy/fork/sandbox/codex-seccomp-v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

const isolationPolicy = {
  version: "1",
  seccompSha256: "3c8cf53ee38d309e4bd3691b306184c5226e48d60ed593d1d94d00104e534c44",
  apparmorSha256: "0c874446ada466bcdc6e01dec906d61a4261788bfa50127cb36da21947fd7e3e",
};

const fixture = (controlTls?: { hostname: string; bridgeAddress: string; publicCaPem: string }) => {
  const resources = new Map<
    string,
    {
      Id: string;
      Name: string;
      Labels: Record<string, string>;
      Config: { Labels: Record<string, string> };
      HostConfig: { SecurityOpt: string[] };
      State: { Running: boolean };
    }
  >();
  const invocations: string[][] = [];
  let loseStartResponse = false;
  let policyValid = true;
  let isolationValid = true;
  let policyControl: string | null = controlTls ? `${controlTls.bridgeAddress}:443` : null;
  const runner = ProcessRunner.ProcessRunner.of({
    run: (command) =>
      Effect.sync(() => {
        const args = command.args.filter((arg) => !arg.startsWith("--host="));
        invocations.push(args);
        const [kind, operation] = args;
        const name = args.at(-1)!;
        let stdout = "";
        let code = 0;
        if (command.args[0]?.endsWith("/isolation-policy.py")) {
          stdout = JSON.stringify({
            ...isolationPolicy,
            ...(isolationValid ? {} : { seccompSha256: "tampered" }),
          });
        } else if (command.command === "/usr/bin/python3") {
          code = policyValid ? 0 : 1;
          stdout = JSON.stringify({
            name: "foundry-sandbox-test",
            action: "inspect",
            verified: true,
            control: policyControl,
            dns: "1.1.1.1",
          });
        } else if (kind === "network" && operation === "inspect") {
          stdout = JSON.stringify([
            { Driver: "bridge", Labels: { "com.foundry.egress-policy": "restricted-v1" } },
          ]);
        } else if (operation === "ls") {
          stdout = [...resources.values()]
            .filter((r) => r.Name === name.replace(/^name=\^\/?/, "").replace(/\$$/, ""))
            .map((r) => r.Name)
            .join("\n");
        } else if (operation === "inspect") {
          const found = resources.get(`${kind}:${name}`);
          if (found) stdout = JSON.stringify([found]);
          else code = 1;
        } else if (operation === "create") {
          const resourceName = kind === "container" ? args[args.indexOf("--name") + 1]! : name;
          if (resources.has(`${kind}:${resourceName}`)) code = 1;
          else {
            const labels = Object.fromEntries(
              args.flatMap((arg, i) => (arg === "--label" ? [args[i + 1]!.split("=")] : [])),
            );
            const resource = {
              Id: resourceName,
              Name: resourceName,
              Labels: labels,
              Config: { Labels: labels },
              HostConfig: {
                SecurityOpt: args
                  .filter((a) => a.startsWith("--security-opt="))
                  .map((a) =>
                    a.startsWith("--security-opt=seccomp=")
                      ? `seccomp=${seccompPolicy}`
                      : a.slice("--security-opt=".length),
                  ),
              },
              State: { Running: false },
            };
            resources.set(`${kind}:${resourceName}`, resource);
            stdout = resourceName;
          }
        } else if (operation === "start") {
          resources.get(`container:${name}`)!.State.Running = !args.includes("--attach");
          if (args.includes("--attach")) stdout = '{"manifests":[]}';
          if (loseStartResponse) {
            loseStartResponse = false;
            code = 1;
          }
        } else if (operation === "stop") resources.get(`container:${name}`)!.State.Running = false;
        else if (operation === "rm") resources.delete(`${kind}:${name}`);
        else throw new Error(`Unexpected command ${args.join(" ")}`);
        return {
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  return {
    resources,
    invocations,
    changeControl: () => {
      policyControl = "172.30.240.1:444";
    },
    invalidateIsolation: () => {
      isolationValid = false;
    },
    invalidatePolicy: () => {
      policyValid = false;
    },
    loseStart: () => {
      loseStartResponse = true;
    },
    layer: OciSupervisor.layer({
      maxCpuMillis: 4000,
      maxMemoryMiB: 4096,
      maxPids: 512,
      networkName: "foundry-sandbox-test",
      ...(controlTls ? { controlTls } : {}),
    }).pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner))),
  };
};

it.effect(
  "reconciles a lost start response and restart without duplicate containers or volumes",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.loseStart();
      const first = yield* Effect.gen(function* () {
        return yield* (yield* OciSupervisor.OciSupervisor).ensure(input);
      }).pipe(Effect.provide(f.layer));
      const second = yield* Effect.gen(function* () {
        return yield* (yield* OciSupervisor.OciSupervisor).ensure(input);
      }).pipe(Effect.provide(f.layer));
      expect(second).toEqual(first);
      expect(f.resources.size).toBe(2);
      expect(
        f.invocations.filter((args) => args[0] === "container" && args[1] === "create"),
      ).toHaveLength(1);
      const create = f.invocations.find((args) => args[0] === "container" && args[1] === "create")!;
      expect(create).toContain("--read-only");
      expect(create).toContain("--cap-drop=ALL");
      expect(create).toContain("--security-opt=no-new-privileges:true");
      expect(create).toContain("--user=1000:1000");
      expect(create).toContain("--network=none");
      expect(create).toContain("--memory=512m");
      expect(create).toContain("--memory-swap=512m");
      expect(create).toContain("--pids-limit=128");
      expect(create).toContain("--cpus=1");
    }),
);

it.effect(
  "rejects drift, excessive limits and foreign ownership, and never removes a running writer",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const supervisor = yield* OciSupervisor.OciSupervisor;
        const started = yield* supervisor.ensure(input);
        expect(
          (yield* supervisor.ensure({ ...input, image: "ubuntu:latest" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* supervisor.ensure({ ...input, cpuMillis: 8000 }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* supervisor.ensure({ ...input, memoryMiB: 1024 }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* supervisor.remove(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.resources.size).toBe(2);
        const resource = f.resources.get(`container:${started.containerName}`)!;
        resource.Config.Labels["com.foundry.instance"] = "foreign";
        expect((yield* supervisor.stop(input).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* supervisor.remove(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(resource.State.Running).toBe(true);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("stops and deletes only its resources, with idempotent repeated cleanup", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const supervisor = yield* OciSupervisor.OciSupervisor;
      yield* supervisor.ensure(input);
      yield* supervisor.ensure({ ...input, allocationId: "another" });
      yield* supervisor.stop(input);
      yield* supervisor.remove(input);
      yield* supervisor.remove(input);
      expect(yield* supervisor.inspect(input)).toBeNull();
      expect(f.resources.size).toBe(2);
      expect((yield* supervisor.inspect({ ...input, allocationId: "another" }))?.running).toBe(
        true,
      );
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "fences finalization behind stopped writers and blocks restart or deletion while its helper runs",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const supervisor = yield* OciSupervisor.OciSupervisor;
        const original = yield* supervisor.ensure(input);
        const command = {
          argv: ["node", "/app/dist/bin.mjs", "foundry", "sandbox-archive", "capture-environment"],
        };
        expect((yield* supervisor.finalize(input, command).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* supervisor.stop(input);
        expect(
          (yield* supervisor
            .finalize(input, { argv: ["sh", "-c", "anything"] })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const result = yield* supervisor.finalize(input, command);
        expect(result).toEqual({
          state: "completed",
          stdout: '{"manifests":[]}',
          stderr: "",
          exitCode: 0,
        });
        expect((yield* supervisor.inspect(input))?.running).toBe(false);
        expect(f.resources.size).toBe(2);
        const parent = f.resources.get(`container:${original.containerName}`)!;
        const labels = {
          ...parent.Labels,
          "com.foundry.role": "finalizer",
          "com.foundry.finalizer-deadline": "600000",
        };
        const name = `${original.containerName}-finalizer`;
        f.resources.set(`container:${name}`, {
          Id: name,
          Name: name,
          Labels: labels,
          Config: { Labels: labels },
          HostConfig: parent.HostConfig,
          State: { Running: true },
        });
        expect(yield* supervisor.finalize(input, command)).toEqual({ state: "running" });
        expect((yield* supervisor.ensure(input).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* supervisor.remove(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(parent.State.Running).toBe(false);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("verifies actual operator firewall policy before creation and restart and pins DNS", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const oci = yield* OciSupervisor.OciSupervisor;
      yield* oci.ensure({ ...input, network: "configured" });
      const create = f.invocations.find((args) => args[0] === "container" && args[1] === "create")!;
      expect(create).toContain("--dns=1.1.1.1");
      f.invalidatePolicy();
      expect(
        (yield* oci.ensure({ ...input, network: "configured" }).pipe(Effect.flip)).reason,
      ).toBe("network-policy");
      expect(f.resources.size).toBe(2);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("pins the verified control endpoint and CA for runtime and archive helpers", () =>
  Effect.gen(function* () {
    const control = {
      hostname: "foundry.example.test",
      bridgeAddress: "172.30.240.1",
      publicCaPem: TEST_SANDBOX_CA,
    };
    const f = fixture(control);
    yield* Effect.gen(function* () {
      const oci = yield* OciSupervisor.OciSupervisor;
      yield* oci.ensure({ ...input, network: "configured" });
      const original = f.invocations.find(
        (args) => args[0] === "container" && args[1] === "create",
      )!;
      expect(original).toContain("--add-host=foundry.example.test:172.30.240.1");
      expect(
        original.some((arg) => arg.startsWith("--env=FOUNDRY_SANDBOX_CONTROL_CA_SHA256=")),
      ).toBe(true);
      yield* oci.stop(input);
      yield* oci.finalize(input, {
        argv: ["node", "/app/foundry-sandbox-bootstrap.mjs", "read-archive"],
      });
      const helper = f.invocations
        .filter((args) => args[0] === "container" && args[1] === "create")
        .at(-1)!;
      expect(helper).toContain("--add-host=foundry.example.test:172.30.240.1");
      expect(helper).toContain("--env=NODE_EXTRA_CA_CERTS=/workspace/.foundry/control-ca.pem");
      control.hostname = "changed.example.test";
      expect(
        (yield* oci.ensure({ ...input, network: "configured" }).pipe(Effect.flip)).reason,
      ).toBe("drift");
      control.hostname = "foundry.example.test";
      f.changeControl();
      expect(
        (yield* oci.ensure({ ...input, network: "configured" }).pipe(Effect.flip)).reason,
      ).toBe("network-policy");
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "rejects changed isolation files before allocation and changed container security options",
  () =>
    Effect.gen(function* () {
      const rejected = fixture();
      rejected.invalidateIsolation();
      yield* Effect.gen(function* () {
        const supervisor = yield* OciSupervisor.OciSupervisor;
        expect((yield* supervisor.ensure(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(rejected.resources.size).toBe(0);
      }).pipe(Effect.provide(rejected.layer));
      const f = fixture();
      yield* Effect.gen(function* () {
        const supervisor = yield* OciSupervisor.OciSupervisor;
        const started = yield* supervisor.ensure(input);
        const resource = f.resources.get(`container:${started.containerName}`)!;
        expect(resource.HostConfig.SecurityOpt).toContain("apparmor=foundry-sandbox-codex-v1");
        const originalOptions = resource.HostConfig.SecurityOpt;
        resource.HostConfig.SecurityOpt = originalOptions.map((option) =>
          option.startsWith("seccomp=") ? 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}' : option,
        );
        expect((yield* supervisor.inspect(input).pipe(Effect.result))._tag).toBe("Failure");
        resource.HostConfig.SecurityOpt = ["no-new-privileges:true", "apparmor=unconfined"];
        expect((yield* supervisor.inspect(input).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* supervisor.stop(input).pipe(Effect.result))._tag).toBe("Failure");
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("preserves legacy policy for inspection, restart and archive finalization", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const supervisor = yield* OciSupervisor.OciSupervisor;
      const started = yield* supervisor.ensure(input);
      const resource = f.resources.get(`container:${started.containerName}`)!;
      const stored = JSON.parse(resource.Labels["com.foundry.provision"]!);
      delete stored.isolationPolicy;
      const legacy = JSON.stringify(stored);
      const fingerprint = NodeCrypto.createHash("sha256").update(legacy).digest("hex");
      for (const item of f.resources.values()) {
        item.Labels["com.foundry.provision"] = legacy;
        item.Labels["com.foundry.spec"] = fingerprint;
      }
      resource.HostConfig.SecurityOpt = ["no-new-privileges:true"];
      f.invalidateIsolation();
      yield* supervisor.stop(input);
      yield* supervisor.ensure(input);
      yield* supervisor.stop(input);
      expect(
        (yield* supervisor.finalize(input, {
          argv: ["node", "/app/foundry-sandbox-bootstrap.mjs", "read-archive"],
        })).state,
      ).toBe("completed");
      const create = f.invocations
        .filter((args) => args[0] === "container" && args[1] === "create")
        .at(-1)!;
      expect(create).not.toContain("--security-opt=apparmor=foundry-sandbox-codex-v1");
      yield* supervisor.remove(input);
      expect(f.resources.size).toBe(0);
    }).pipe(Effect.provide(f.layer));
  }),
);
