// @effect-diagnostics nodeBuiltinImport:off -- Native Git fixtures prove the tested tree and transferred bundle are identical.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FoundryPublishRequest } from "@t3tools/contracts";
import { verifyBundle, saveRequest, readRequest } from "./WorkerPublishEvidence.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
it.live(
  "binds successful checks to the exact immutable bundle and rejects dirty or changed tested trees",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-evidence-test-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const git = Effect.fn("EvidenceFixture.git")((...args: string[]) =>
          Effect.promise(async () =>
            (await execute("git", args, { cwd: directory })).stdout.trim(),
          ),
        );
        yield* git("init", "-b", "main");
        yield* git("config", "user.name", "Foundry Fixture");
        yield* git("config", "user.email", "fixture@invalid.test");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(directory, "checked.txt"), "expected\n");
          await NodeFSP.mkdir(NodePath.join(directory, "nested"));
          await NodeFSP.writeFile(NodePath.join(directory, "nested", "specific.txt"), "nested");
        });
        yield* git("add", "checked.txt", "nested/specific.txt");
        yield* git("commit", "-m", "Fixture");
        yield* git("update-ref", "refs/t3/checkpoint", "HEAD");
        const request = {
          repository: "owner/test",
          baseBranch: "main",
          checks: [
            { id: "contents", command: 'test "$(cat checked.txt)" = expected', cwd: directory },
          ],
        };
        const input = { cwd: directory, checkpointRef: "refs/t3/checkpoint", request };
        const stateDir = NodePath.join(directory, ".git", "fixture-state");
        yield* Effect.all(
          [saveRequest(stateDir, "command", request), saveRequest(stateDir, "command", request)],
          { concurrency: 2 },
        );
        expect(yield* readRequest(stateDir, "command", FoundryPublishRequest)).toEqual(request);
        expect(
          (yield* saveRequest(stateDir, "command", { ...request, baseBranch: "other" }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        const proof = yield* verifyBundle(input);
        expect(proof.commitSha).toBe(yield* git("rev-parse", "HEAD"));
        expect(proof.treeSha).toBe(yield* git("rev-parse", "HEAD^{tree}"));
        expect(proof.checks[0]?.commitSha).toBe(proof.commitSha);
        expect(proof.bytes.length).toBeGreaterThan(0);
        const nested = yield* verifyBundle({
          ...input,
          request: {
            ...request,
            checks: [
              {
                id: "nested",
                command: "test -f specific.txt",
                cwd: NodePath.join(directory, "nested"),
              },
            ],
          },
        });
        expect(nested.checks[0]?.relativeCwd).toBe("nested");
        expect(nested.sourceCwd).toBe(directory);
        const escape = yield* verifyBundle({
          ...input,
          request: {
            ...request,
            checks: [{ id: "escape", command: "true", cwd: NodePath.dirname(directory) }],
          },
        }).pipe(Effect.flip);
        expect(escape.reason).toBe("changed_commit");
        const failed = yield* verifyBundle({
          ...input,
          request: { ...request, checks: [{ id: "contents", command: "exit 1", cwd: directory }] },
        }).pipe(Effect.flip);
        expect(failed.reason).toBe("test_failed");
        const changed = yield* verifyBundle({
          ...input,
          request: {
            ...request,
            checks: [{ id: "contents", command: "echo changed >> checked.txt", cwd: directory }],
          },
        }).pipe(Effect.flip);
        expect(changed.reason).toBe("changed_commit");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, "checked.txt"), "dirty\n"),
        );
        expect((yield* verifyBundle(input).pipe(Effect.flip)).reason).toBe("dirty_commit");
        yield* git("add", "checked.txt");
        yield* git("commit", "-m", "Different commit");
        expect((yield* verifyBundle(input).pipe(Effect.flip)).reason).toBe("changed_commit");
      }),
    ),
);
