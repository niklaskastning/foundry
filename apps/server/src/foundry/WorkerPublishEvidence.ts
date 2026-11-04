// @effect-diagnostics nodeBuiltinImport:off -- Git evidence is captured from an immutable local bundle and checked in a disposable worker checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  FoundryPublishRequest,
  type FoundryWorkerLaunchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ArtifactPublication from "./ArtifactPublication.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

const decodeAttachment = Schema.decodeEffect(ChatFileAttachment);
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export type EvidenceRequest = NonNullable<FoundryWorkerLaunchInput["publishEvidence"]>;
export class WorkerPublishError extends Schema.TaggedError<WorkerPublishError>()(
  "WorkerPublishError",
  { reason: Schema.Literals(["dirty_commit", "test_failed", "changed_commit", "unavailable"]) },
) {}
const isWorkerPublishError = Schema.is(WorkerPublishError);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(FoundryPublishRequest));
const unavailable = () => new WorkerPublishError({ reason: "unavailable" });
const git = async (cwd: string, args: ReadonlyArray<string>) =>
  (
    await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout.trim();
const key = (commandId: string) => NodeCrypto.createHash("sha256").update(commandId).digest("hex");
const requestPath = (stateDir: string, commandId: string) =>
  NodePath.join(stateDir, "foundry-publish-evidence", `${key(commandId)}.json`);
export const saveRequest = Effect.fn("WorkerPublishEvidence.saveRequest")(
  (stateDir: string, commandId: string, request: EvidenceRequest) =>
    Effect.tryPromise({
      try: async () => {
        const path = requestPath(stateDir, commandId);
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
        const text = encodeRequest(request);
        const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          const file = await NodeFSP.open(temporary, "wx", 0o600);
          try {
            await file.writeFile(text);
            await file.sync();
          } finally {
            await file.close();
          }
          try {
            await NodeFSP.link(temporary, path);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              (await NodeFSP.readFile(path, "utf8")) !== text
            )
              throw error;
          }
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      },
      catch: unavailable,
    }),
);
export const readRequest = Effect.fn("WorkerPublishEvidence.readRequest")(
  (stateDir: string, commandId: string, schema: Schema.Codec<EvidenceRequest>) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.readFile(requestPath(stateDir, commandId), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      catch: unavailable,
    }).pipe(
      Effect.flatMap((text) =>
        text === null
          ? Effect.succeed(null)
          : Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
              Effect.mapError(unavailable),
            ),
      ),
    ),
);

export const verifyBundle = Effect.fn("WorkerPublishEvidence.verifyBundle")(
  (input: { cwd: string; checkpointRef: string; request: EvidenceRequest }) =>
    Effect.tryPromise({
      try: async () => {
        if (await git(input.cwd, ["status", "--porcelain", "--untracked-files=normal"]))
          throw new WorkerPublishError({ reason: "dirty_commit" });
        const sourceCwd = await NodeFSP.realpath(input.cwd);
        const commitSha = await git(input.cwd, ["rev-parse", "HEAD"]);
        const treeSha = await git(input.cwd, ["rev-parse", "HEAD^{tree}"]);
        if ((await git(input.cwd, ["rev-parse", `${input.checkpointRef}^{tree}`])) !== treeSha)
          throw new WorkerPublishError({ reason: "changed_commit" });
        const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-publish-"));
        try {
          const bundle = NodePath.join(temporary, "result.bundle");
          await git(input.cwd, ["bundle", "create", bundle, "HEAD"]);
          const stat = await NodeFSP.stat(bundle);
          if (stat.size > 50 * 1024 * 1024) throw unavailable();
          await git(temporary, ["clone", "--no-checkout", "--", bundle, "verify"]);
          const checkout = NodePath.join(temporary, "verify");
          await git(checkout, ["checkout", "--detach", commitSha]);
          const checks: Array<{
            id: string;
            command: string;
            cwd: string;
            relativeCwd: string;
            exitCode: 0;
            commitSha: string;
            treeSha: string;
          }> = [];
          for (const check of input.request.checks) {
            const configuredCwd = await NodeFSP.realpath(NodePath.resolve(sourceCwd, check.cwd));
            const relativeCwd = NodePath.relative(sourceCwd, configuredCwd) || ".";
            if (
              relativeCwd === ".." ||
              relativeCwd.startsWith(`..${NodePath.sep}`) ||
              NodePath.isAbsolute(relativeCwd)
            )
              throw new WorkerPublishError({ reason: "changed_commit" });
            const checkedCwd = await NodeFSP.realpath(NodePath.resolve(checkout, relativeCwd));
            const checkedRelative = NodePath.relative(checkout, checkedCwd);
            if (
              checkedRelative === ".." ||
              checkedRelative.startsWith(`..${NodePath.sep}`) ||
              NodePath.isAbsolute(checkedRelative)
            )
              throw new WorkerPublishError({ reason: "changed_commit" });
            try {
              await execute(
                "timeout",
                ["--kill-after=5s", "300s", "bash", "--noprofile", "--norc", "-c", check.command],
                {
                  cwd: checkedCwd,
                  maxBuffer: 1024 * 1024,
                  timeout: 310000,
                  env: {
                    PATH: process.env.PATH,
                    HOME: NodePath.join(temporary, "home"),
                    CI: "1",
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_TERMINAL_PROMPT: "0",
                  },
                },
              );
            } catch {
              throw new WorkerPublishError({ reason: "test_failed" });
            }
            if (
              (await git(checkout, ["rev-parse", "HEAD"])) !== commitSha ||
              (await git(checkout, ["status", "--porcelain", "--untracked-files=normal"]))
            )
              throw new WorkerPublishError({ reason: "changed_commit" });
            checks.push({
              id: check.id,
              command: check.command,
              cwd: check.cwd,
              relativeCwd,
              exitCode: 0,
              commitSha,
              treeSha,
            });
          }
          if (checks.length === 0) throw new WorkerPublishError({ reason: "test_failed" });
          const bytes = new Uint8Array(await NodeFSP.readFile(bundle));
          return { sourceCwd, commitSha, treeSha, checks, bytes };
        } finally {
          await NodeFSP.rm(temporary, { recursive: true, force: true });
        }
      },
      catch: (error) => (isWorkerPublishError(error) ? error : unavailable()),
    }),
);

export const capture = Effect.fn("WorkerPublishEvidence.capture")(function* (input: {
  cwd: string;
  checkpointRef: string;
  request: EvidenceRequest;
  commandId: string;
  threadId: string;
  attachmentsDir: string;
}) {
  const publication = yield* ArtifactPublication.ArtifactPublication;
  if (!publication) return yield* unavailable();
  const result = yield* verifyBundle(input);
  const id = createDeterministicAttachmentId(
    input.threadId,
    `publish:${input.commandId}:${result.commitSha}`,
  );
  if (!id) return yield* unavailable();
  const attachment = yield* decodeAttachment({
    type: "file",
    id: ChatAttachmentId.make(id),
    name: "foundry-result.bundle",
    mimeType: "application/octet-stream",
    sizeBytes: result.bytes.length,
  }).pipe(Effect.mapError(unavailable));
  const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
  if (!path) return yield* unavailable();
  yield* Effect.tryPromise({
    try: () => NodeFSP.writeFile(path, result.bytes, { mode: 0o600 }),
    catch: unavailable,
  });
  const published = yield* publication.publishAttachment(
    input.threadId,
    attachment,
    `publish:${input.commandId}`,
  );
  if (!published.foundryArtifact) return yield* unavailable();
  return {
    sourceCwd: result.sourceCwd,
    repository: input.request.repository,
    baseBranch: input.request.baseBranch,
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    checks: result.checks,
    bundle: published.foundryArtifact,
  };
});
